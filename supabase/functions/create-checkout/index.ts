import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const ERRORS: Record<string, string> = {
  invalid_name: "Escribe tu nombre completo.",
  invalid_email: "El correo no es válido.",
  invalid_numbers: "Elige entre 1 y 15 números.",
  not_found: "No encontramos esa rifa.",
  raffle_closed: "Esta rifa ya no está vendiendo números.",
  duplicate_numbers: "Hay números repetidos en tu selección.",
  number_out_of_range: "Uno de los números no existe en esta rifa.",
  number_taken: "Alguien acaba de tomar uno de esos números. Elige otros.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "method" }, 405);
  }

  const mpToken = Deno.env.get("MP_ACCESS_TOKEN");
  const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!mpToken || !siteUrl || !supabaseUrl || !serviceKey) {
    return json({
      error: "server_not_configured",
      message: "Falta configurar Mercado Pago o la dirección del sitio.",
    }, 500);
  }

  let body: {
    raffleId?: string;
    numbers?: number[];
    buyerName?: string;
    buyerEmail?: string;
    buyerPhone?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }

  const numbers = Array.isArray(body.numbers)
    ? body.numbers.map((n) => Number(n)).filter((n) => Number.isInteger(n))
    : [];

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data, error } = await supabase.rpc("reserve_numbers", {
    p_raffle_id: body.raffleId,
    p_numbers: numbers,
    p_name: body.buyerName ?? "",
    p_email: body.buyerEmail ?? "",
    p_phone: body.buyerPhone ?? "",
  });

  if (error || !data) {
    const code = error?.message?.match(/[a-z_]+/)?.[0] ?? "reserve_failed";
    const status = code === "number_taken" ? 409 : 400;
    return json({ error: code, message: ERRORS[code] ?? "No se pudo reservar." }, status);
  }

  const order = data as {
    order_id: string;
    amount: number;
    unit_price: number;
    title: string;
    reserved_until: string;
    numbers: number[];
  };

  const label = order.numbers.slice().sort((a, b) => a - b).join(", ");
  const preference = {
    items: [
      {
        title: `${order.title} — números ${label}`.slice(0, 120),
        quantity: order.numbers.length,
        unit_price: order.unit_price,
        currency_id: "CLP",
      },
    ],
    payer: {
      name: body.buyerName,
      email: body.buyerEmail,
    },
    external_reference: order.order_id,
    notification_url: `${supabaseUrl}/functions/v1/mp-webhook`,
    back_urls: {
      success: `${siteUrl}/?rifa=${body.raffleId}&orden=${order.order_id}&pago=ok`,
      pending: `${siteUrl}/?rifa=${body.raffleId}&orden=${order.order_id}&pago=pendiente`,
      failure: `${siteUrl}/?rifa=${body.raffleId}&orden=${order.order_id}&pago=error`,
    },
    auto_return: "approved",
    expires: true,
    expiration_date_to: order.reserved_until,
    statement_descriptor: "RIFA ONLINE",
    metadata: {
      raffle_id: body.raffleId,
      numbers: label,
    },
  };

  const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mpToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(preference),
  });

  const mpBody = await mpRes.json();
  if (!mpRes.ok || !mpBody.init_point) {
    await supabase.rpc("release_order", { p_order_id: order.order_id });
    return json({ error: "mp_failed", message: "Mercado Pago no pudo abrir el cobro." }, 502);
  }

  await supabase.rpc("attach_preference", {
    p_order_id: order.order_id,
    p_preference_id: mpBody.id ?? "",
  });

  return json({
    orderId: order.order_id,
    initPoint: mpBody.init_point,
    reservedUntil: order.reserved_until,
  });
});
