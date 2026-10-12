import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ ok: false }, 405);
  }

  const mpToken = Deno.env.get("MP_ACCESS_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!mpToken || !supabaseUrl || !serviceKey) {
    return json({ error: "server_not_configured" }, 500);
  }

  const url = new URL(req.url);
  let paymentId = url.searchParams.get("data.id") || url.searchParams.get("id");
  let topic = url.searchParams.get("topic") || url.searchParams.get("type");

  if (req.method === "POST") {
    try {
      const body = await req.json();
      topic = topic || body.type || body.topic || "";
      paymentId = paymentId || body?.data?.id || body?.id || null;
    } catch {
      // Mercado Pago a veces avisa solo con la query string.
    }
  }

  if (!paymentId || (topic && !String(topic).includes("payment"))) {
    return json({ ok: true, ignored: true });
  }

  const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${mpToken}` },
  });
  if (!payRes.ok) {
    return json({ error: "mp_lookup_failed" }, 502);
  }

  const payment = await payRes.json();
  const orderId = payment.external_reference as string | undefined;
  if (!orderId) {
    return json({ ok: true, ignored: true });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const amount = Math.round(Number(payment.transaction_amount));

  if (payment.status === "approved" && payment.currency_id === "CLP") {
    const { data, error } = await supabase.rpc("confirm_payment", {
      p_order_id: orderId,
      p_payment_id: String(payment.id),
      p_amount: amount,
    });
    if (error) {
      return json({ error: error.message }, 500);
    }
    if (data === "amount_mismatch") {
      return json({ error: "amount_mismatch" }, 409);
    }
    return json({ ok: true, result: data });
  }

  if (payment.status === "rejected" || payment.status === "cancelled") {
    await supabase.rpc("release_order", { p_order_id: orderId });
  }

  return json({ ok: true, status: payment.status });
});
