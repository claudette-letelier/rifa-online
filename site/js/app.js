const cfg = window.RIFA_CONFIG || {};
const live = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
const DEMO_KEY = "rifa-online-demo";
const MINE_KEY = "rifa-online-mine";

let supabase = null;
let cache = null;
let cacheKey = "";
let selected = new Set();
let buyer = { name: "", email: "", phone: "" };
let draft = {
  title: "",
  prize: "",
  description: "",
  price: "2000",
  total: "100",
  organizer: "",
  phone: "",
  bank: "BancoEstado",
  bankOther: "",
  accountType: "Cuenta RUT",
  accountNumber: "",
  rut: "",
  holder: "",
  prizeImage: "",
  drawAt: "",
};

let onlyFree = false;
let numberQuery = "";

const BANKS = [
  "BancoEstado",
  "Banco de Chile",
  "Banco Santander",
  "BCI",
  "Scotiabank",
  "Itaú",
  "Banco BICE",
  "Banco Security",
  "Banco Falabella",
  "Banco Ripley",
  "Tenpo",
  "Otro",
];

const ACCOUNT_TYPES = ["Cuenta RUT", "Cuenta vista", "Cuenta corriente", "Cuenta de ahorro"];
let busy = false;
let errorMsg = "";
let renderGen = 0;
let pollTimer = 0;
let avisoTimer = 0;

const clp = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function money(value) {
  return clp.format(Number(value) || 0);
}

function pad(n, total) {
  return String(n).padStart(total >= 100 ? 3 : 2, "0");
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function chilePhone(value) {
  const phone = digits(value);
  if (phone.startsWith("56")) return phone;
  if (phone.length === 9 && phone.startsWith("9")) return `56${phone}`;
  return phone;
}

function showPhone(value) {
  const phone = digits(value);
  if (phone.length === 11 && phone.startsWith("56")) {
    return `+${phone.slice(0, 2)} ${phone.slice(2, 3)} ${phone.slice(3, 7)} ${phone.slice(7)}`;
  }
  return phone || "sin teléfono";
}

function cleanRut(value) {
  return String(value ?? "").replace(/\./g, "").replace(/-/g, "").toUpperCase();
}

function validRut(value) {
  const rut = cleanRut(value);
  if (!/^\d{7,8}[0-9K]$/.test(rut)) return false;
  const body = rut.slice(0, -1);
  const dv = rut.slice(-1);
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const rest = 11 - (sum % 11);
  const expected = rest === 11 ? "0" : rest === 10 ? "K" : String(rest);
  return dv === expected;
}

function formatRut(value) {
  const rut = cleanRut(value);
  const body = rut.slice(0, -1);
  const dv = rut.slice(-1);
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dv}`;
}

function formatWhen(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "full",
    timeStyle: "short",
  }).format(date);
}

function timeLeft(until) {
  const ms = new Date(until).getTime() - Date.now();
  if (!until || Number.isNaN(ms)) return "";
  if (ms <= 0) return "La reserva ya venció";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours >= 1) return `Quedan ${hours} h ${minutes} min para transferir`;
  return `Quedan ${minutes} min para transferir`;
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const max = 900;
      const scale = Math.min(1, max / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la foto."));
    };
    image.src = url;
  });
}

function rpcMessage(error, fallback) {
  const text = error?.message || "";
  const known = {
    number_taken: "Alguien acaba de tomar uno de esos números. Elige otros.",
    raffle_closed: "Esta rifa ya no está vendiendo números.",
    invalid_email: "El correo no es válido.",
    invalid_name: "Escribe tu nombre completo.",
    invalid_numbers: "Elige entre 1 y 15 números.",
    invalid_rut: "El RUT de la cuenta no es válido.",
    invalid_bank: "Revisa el banco, el tipo de cuenta y el número.",
    invalid_raffle: "Revisa los datos. El precio va entre $1.000 y $200.000.",
    invalid_image: "La foto tiene que ser un enlace https o una imagen más liviana.",
    missing_account: "Esta rifa no tiene una cuenta para transferir.",
    expired: "Esa reserva ya venció.",
    already_paid: "Ese pago ya estaba confirmado.",
    cannot_confirm: "Esa reserva ya no se puede confirmar.",
  };
  const code = Object.keys(known).find((key) => text.includes(key));
  return new Error(code ? known[code] : fallback);
}

function pageBase() {
  return new URL("./", location.href).href.replace(/\/$/, "");
}

function publicUrl(id) {
  return `${pageBase()}/?rifa=${encodeURIComponent(id)}`;
}

function adminUrl(id, token) {
  return `${pageBase()}/?admin=${encodeURIComponent(id)}&clave=${encodeURIComponent(token)}`;
}

function route() {
  const q = new URLSearchParams(location.search);
  if (q.get("nueva") === "1") return { name: "create" };
  if (q.get("admin")) {
    return { name: "admin", id: q.get("admin"), token: q.get("clave") || "" };
  }
  if (q.get("rifa")) {
    return {
      name: "raffle",
      id: q.get("rifa"),
      pago: q.get("pago") || "",
      orden: q.get("orden") || "",
    };
  }
  return { name: "home" };
}

function dataKey(r) {
  return `${r.name}:${r.id || ""}:${r.token || ""}`;
}

function go(params) {
  const url = new URL(location.href);
  url.hash = "";
  [...url.searchParams.keys()].forEach((key) => url.searchParams.delete(key));
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") url.searchParams.set(key, value);
  });
  history.pushState({}, "", `${url.pathname}${url.search}`);
  selected = new Set();
  errorMsg = "";
  render(true);
}

function readMine() {
  try {
    return JSON.parse(localStorage.getItem(MINE_KEY) || "[]");
  } catch {
    return [];
  }
}

function remember(entry) {
  const next = [entry, ...readMine().filter((item) => item.id !== entry.id)].slice(0, 20);
  localStorage.setItem(MINE_KEY, JSON.stringify(next));
}

function aviso(message) {
  const el = document.querySelector("#aviso");
  el.textContent = message;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => {
    el.textContent = "";
  }, 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    aviso("Enlace copiado");
  } catch {
    aviso("No se pudo copiar. Selecciona el enlace y cópialo a mano.");
  }
}

function demoLoad() {
  const raw = localStorage.getItem(DEMO_KEY);
  if (raw) return JSON.parse(raw);
  const id = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const db = {
    raffles: [
      {
        id,
        title: "Rifa de la junta de vecinos",
        prize: "Gift card de $80.000",
        description: "Ejemplo para recorrer la página. En el modo demostración nadie paga de verdad.",
        price_clp: 2000,
        total_numbers: 50,
        organizer_name: "Ana Pérez",
        organizer_phone: "56912345678",
        bank_name: "BancoEstado",
        account_type: "Cuenta RUT",
        account_number: "12345678",
        account_rut: "12.345.678-5",
        account_holder: "Ana Pérez",
        admin_token: "demo-clave",
        status: "open",
        winner_number: null,
        drawn_at: null,
        created_at: new Date().toISOString(),
      },
    ],
    orders: [
      {
        id: orderId,
        raffle_id: id,
        buyer_name: "Luis Soto",
        buyer_email: "luis@example.com",
        buyer_phone: "56911111111",
        amount_clp: 2000,
        status: "paid",
        transfer_code: "PAGADO",
        reserved_until: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        paid_at: new Date().toISOString(),
        numbers: [7],
      },
    ],
  };
  localStorage.setItem(DEMO_KEY, JSON.stringify(db));
  return db;
}

function demoSave(db) {
  localStorage.setItem(DEMO_KEY, JSON.stringify(db));
}

function activeOrders(db, raffleId) {
  const now = Date.now();
  return db.orders.filter((order) => {
    if (order.raffle_id !== raffleId) return false;
    if (order.status === "paid") return true;
    if (order.status !== "pending" && order.status !== "reported") return false;
    return new Date(order.reserved_until).getTime() > now;
  });
}

function purgeExpired(db, raffleId) {
  const now = Date.now();
  db.orders.forEach((order) => {
    if (order.raffle_id !== raffleId) return;
    if (order.status !== "pending" && order.status !== "reported") return;
    if (new Date(order.reserved_until).getTime() > now) return;
    order.status = "failed";
    order.numbers = [];
  });
}

const demoApi = {
  async getRaffle(id) {
    const db = demoLoad();
    purgeExpired(db, id);
    demoSave(db);
    const raffle = db.raffles.find((item) => item.id === id);
    if (!raffle) throw new Error("No encontramos esta rifa. Revisa el enlace.");
    if (!raffle.account_number) {
      raffle.bank_name = "BancoEstado";
      raffle.account_type = "Cuenta RUT";
      raffle.account_number = "12345678";
      raffle.account_rut = "12.345.678-5";
      raffle.account_holder = raffle.organizer_name;
    }
    const tickets = activeOrders(db, id)
      .flatMap((order) => order.numbers.map((number) => ({ number, status: order.status === "paid" ? "paid" : "reserved" })));
    return { raffle, tickets };
  },
  async orderStatus(orderId) {
    const order = demoLoad().orders.find((item) => item.id === orderId);
    if (!order) return null;
    return {
      status: order.status,
      raffle_id: order.raffle_id,
      numbers: order.numbers,
      amount_clp: order.amount_clp,
      transfer_code: order.transfer_code,
      reserved_until: order.reserved_until,
    };
  },
  async createRaffle(input) {
    const db = demoLoad();
    const id = crypto.randomUUID();
    const admin_token = crypto.randomUUID().replaceAll("-", "");
    db.raffles.unshift({
      id,
      ...input,
      admin_token,
      status: "open",
      winner_number: null,
      drawn_at: null,
      created_at: new Date().toISOString(),
    });
    demoSave(db);
    return { id, admin_token };
  },
  async checkout(input) {
    const db = demoLoad();
    purgeExpired(db, input.raffleId);
    const raffle = db.raffles.find((item) => item.id === input.raffleId);
    if (!raffle || raffle.status !== "open") throw new Error("Esta rifa ya no está vendiendo números.");
    const taken = new Set(activeOrders(db, input.raffleId).flatMap((order) => order.numbers));
    if (input.numbers.some((number) => taken.has(number))) {
      throw new Error("Alguien acaba de tomar uno de esos números. Elige otros.");
    }
    const orderId = crypto.randomUUID();
    const order = {
      id: orderId,
      raffle_id: input.raffleId,
      buyer_name: input.buyerName.trim(),
      buyer_email: input.buyerEmail.trim().toLowerCase(),
      buyer_phone: chilePhone(input.buyerPhone),
      amount_clp: raffle.price_clp * input.numbers.length,
      status: "reported",
      transfer_code: orderId.replaceAll("-", "").slice(0, 6).toUpperCase(),
      reserved_until: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      paid_at: null,
      numbers: input.numbers,
    };
    db.orders.unshift(order);
    demoSave(db);
    return { orderId: order.id, transferCode: order.transfer_code };
  },
  async getAdmin(id, token) {
    const db = demoLoad();
    const raffle = db.raffles.find((item) => item.id === id && item.admin_token === token);
    if (!raffle) throw new Error("Este enlace de organización no es válido.");
    const orders = activeOrders(db, id);
    return { raffle, orders };
  },
  async setStatus(id, token, status) {
    const db = demoLoad();
    const raffle = db.raffles.find((item) => item.id === id && item.admin_token === token);
    if (!raffle || raffle.status === "drawn") throw new Error("No se puede cambiar el estado de esta rifa.");
    raffle.status = status;
    demoSave(db);
  },
  async draw(id, token) {
    const db = demoLoad();
    const raffle = db.raffles.find((item) => item.id === id && item.admin_token === token);
    if (!raffle) throw new Error("Este enlace de organización no es válido.");
    if (raffle.status === "drawn") throw new Error("Esta rifa ya tiene ganador.");
    const numbers = db.orders
      .filter((order) => order.raffle_id === id && order.status === "paid")
      .flatMap((order) => order.numbers);
    if (!numbers.length) throw new Error("Todavía no hay números pagados para sortear.");
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    raffle.winner_number = numbers[bytes[0] % numbers.length];
    raffle.status = "drawn";
    raffle.drawn_at = new Date().toISOString();
    demoSave(db);
    return { winner_number: raffle.winner_number };
  },
  async confirmOrder(raffleId, token, orderId) {
    const db = demoLoad();
    const raffle = db.raffles.find((item) => item.id === raffleId && item.admin_token === token);
    const order = db.orders.find((item) => item.id === orderId && item.raffle_id === raffleId);
    if (!raffle || !order || order.status === "failed") throw new Error("Esa reserva ya no se puede confirmar.");
    if (order.status !== "paid") {
      order.status = "paid";
      order.paid_at = new Date().toISOString();
      demoSave(db);
    }
  },
  async rejectOrder(raffleId, token, orderId) {
    const db = demoLoad();
    const raffle = db.raffles.find((item) => item.id === raffleId && item.admin_token === token);
    const order = db.orders.find((item) => item.id === orderId && item.raffle_id === raffleId);
    if (!raffle || !order) throw new Error("No encontramos esa reserva.");
    if (order.status === "paid") throw new Error("Ese pago ya estaba confirmado.");
    order.status = "failed";
    order.numbers = [];
    demoSave(db);
  },
};

const liveApi = {
  async client() {
    if (!supabase) {
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
      supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    }
    return supabase;
  },
  async getRaffle(id) {
    const sb = await this.client();
    const raffleRes = await sb.from("raffle_public").select("*").eq("id", id).maybeSingle();
    if (raffleRes.error) throw new Error("No pudimos cargar la rifa.");
    if (!raffleRes.data) throw new Error("No encontramos esta rifa. Revisa el enlace.");
    const ticketsRes = await sb.from("ticket_public").select("number,status").eq("raffle_id", id);
    if (ticketsRes.error) throw new Error("No pudimos cargar los números.");
    return { raffle: raffleRes.data, tickets: ticketsRes.data || [] };
  },
  async orderStatus(orderId) {
    const sb = await this.client();
    const { data, error } = await sb.rpc("order_status", { p_order_id: orderId });
    if (error) return null;
    return data;
  },
  async createRaffle(input) {
    const sb = await this.client();
    const payload = {
      p_title: input.title,
      p_prize: input.prize,
      p_description: input.description,
      p_price: input.price_clp,
      p_total: input.total_numbers,
      p_organizer_name: input.organizer_name,
      p_organizer_phone: input.organizer_phone,
      p_bank_name: input.bank_name,
      p_account_type: input.account_type,
      p_account_number: input.account_number,
      p_account_rut: input.account_rut,
      p_account_holder: input.account_holder,
    };
    let result = await sb.rpc("create_raffle", {
      ...payload,
      p_prize_image: input.prize_image_url || "",
      p_draw_at: input.draw_at,
    });
    if (result.error && /create_raffle|schema cache|PGRST202/i.test(result.error.message || "")) {
      result = await sb.rpc("create_raffle", payload);
    }
    if (result.error || !result.data) throw rpcMessage(result.error, "No se pudo publicar la rifa. Revisa los datos de la cuenta.");
    return result.data;
  },
  async checkout(input) {
    const sb = await this.client();
    const { data, error } = await sb.rpc("reserve_numbers", {
      p_raffle_id: input.raffleId,
      p_numbers: input.numbers,
      p_name: input.buyerName,
      p_email: input.buyerEmail,
      p_phone: input.buyerPhone,
    });
    if (error || !data) throw rpcMessage(error, "No se pudieron reservar los números.");
    return { orderId: data.order_id, transferCode: data.transfer_code };
  },
  async getAdmin(id, token) {
    const sb = await this.client();
    const { data, error } = await sb.rpc("get_admin_raffle", {
      p_raffle_id: id,
      p_token: token,
    });
    if (error || !data) throw new Error("Este enlace de organización no es válido.");
    return data;
  },
  async setStatus(id, token, status) {
    const sb = await this.client();
    const { error } = await sb.rpc("set_raffle_status", {
      p_raffle_id: id,
      p_token: token,
      p_status: status,
    });
    if (error) throw new Error("No se puede cambiar el estado de esta rifa.");
  },
  async draw(id, token) {
    const sb = await this.client();
    const { data, error } = await sb.rpc("draw_winner", {
      p_raffle_id: id,
      p_token: token,
    });
    if (error) throw new Error("No se pudo sortear. Confirma que haya números pagados y que la rifa no tenga ganador.");
    return data;
  },
  async confirmOrder(raffleId, token, orderId) {
    const sb = await this.client();
    const { error } = await sb.rpc("confirm_transfer", {
      p_raffle_id: raffleId,
      p_token: token,
      p_order_id: orderId,
    });
    if (error) throw rpcMessage(error, "No se pudo confirmar el pago.");
  },
  async rejectOrder(raffleId, token, orderId) {
    const sb = await this.client();
    const { error } = await sb.rpc("reject_transfer", {
      p_raffle_id: raffleId,
      p_token: token,
      p_order_id: orderId,
    });
    if (error) throw rpcMessage(error, "No se pudo liberar el número.");
  },
};

const api = live ? liveApi : demoApi;

function statusLabel(status) {
  if (status === "closed") return "Ventas cerradas";
  if (status === "drawn") return "Sorteada";
  return "Vendiendo";
}

function homeView(data) {
  const sample = data.sampleId
    ? `<a class="btn btn-claro" href="./?rifa=${esc(data.sampleId)}" data-go="raffle" data-id="${esc(data.sampleId)}">Ver rifa de ejemplo</a>`
    : "";
  const mine = data.mine.length
    ? `<section class="bloque"><h2>Rifas de este navegador</h2><div class="lista">${data.mine
        .map(
          (item) => `<article class="tarjeta compra">
            <div><strong>${esc(item.title)}</strong><p class="muted">${esc(item.prize)}</p></div>
            <a class="btn btn-navy" href="${esc(adminUrl(item.id, item.token))}" data-go="admin" data-id="${esc(item.id)}" data-token="${esc(item.token)}">Organizar</a>
          </article>`,
        )
        .join("")}</div></section>`
    : "";
  return `<section class="hero">
      <div>
        <h1>La rifa se comparte por enlace, no en una hoja.</h1>
        <p class="lead">Armas el premio, publicas los números y la gente en cualquier parte de Chile elige el suyo. La transferencia llega a la cuenta de quien creó la rifa.</p>
        <div class="acciones">
          <a class="btn btn-primario" href="./?nueva=1" data-go="create">Armar una rifa</a>
          ${sample}
        </div>
      </div>
      <article class="boleto">
        <div class="sello">Nº 07</div>
        <p class="muted">Premio</p>
        <p class="premio">Un solo enlace para toda la rifa</p>
        <p class="muted">WhatsApp, Instagram o el grupo del curso. Quien abre el enlace ve los números libres.</p>
      </article>
    </section>
    <section class="pasos">
      <article class="tarjeta"><strong>1. Publicas</strong><p class="muted">Premio, precio y la cuenta donde quieres recibir la transferencia.</p></article>
      <article class="tarjeta"><strong>2. Eligen y transfieren</strong><p class="muted">Cada persona marca sus números y transfiere con un código para que puedas reconocer el pago.</p></article>
      <article class="tarjeta"><strong>3. Confirmas y sorteas</strong><p class="muted">Cuando veas la plata en tu cuenta, marcas el número como pagado y después sorteas.</p></article>
    </section>
    ${mine}`;
}

function createView() {
  return `<section class="formulario">
      <h1>Armar rifa</h1>
      <p class="lead">Después vas a recibir un enlace público para compartir y otro privado para ver pagos y sortear.</p>
      ${errorMsg ? `<p class="alerta">${esc(errorMsg)}</p>` : ""}
      <form id="form-rifa">
        <label for="titulo">Nombre de la rifa</label>
        <input id="titulo" name="title" required minlength="3" maxlength="80" placeholder="Rifa curso 4º medio" value="${esc(draft.title)}" />
        <label for="premio">Premio</label>
        <input id="premio" name="prize" required minlength="3" maxlength="140" placeholder="Bicicleta o gift card" value="${esc(draft.prize)}" />
        <label for="foto">Foto del premio</label>
        <input id="foto" name="photo" type="file" accept="image/jpeg,image/png,image/webp" />
        ${draft.prizeImage ? `<img class="premio-foto" alt="Vista previa del premio" src="${esc(draft.prizeImage)}" />` : ""}
        <p class="ayuda">Opcional. Se muestra arriba de los números.</p>
        <label for="sorteo">Fecha del sorteo</label>
        <input id="sorteo" name="drawAt" type="datetime-local" value="${esc(draft.drawAt)}" />
        <label for="detalle">Detalle</label>
        <textarea id="detalle" name="description" maxlength="500" placeholder="Cómo se entrega el premio y cualquier condición.">${esc(draft.description)}</textarea>
        <label for="precio">Precio por número</label>
        <input id="precio" name="price" type="number" min="1000" max="200000" step="500" required value="${esc(draft.price)}" />
        <p class="ayuda">Entre $1.000 y $200.000 pesos.</p>
        <label for="total">Cantidad de números</label>
        <select id="total" name="total">
          <option value="50" ${draft.total === "50" ? "selected" : ""}>50</option>
          <option value="100" ${draft.total === "100" ? "selected" : ""}>100</option>
          <option value="200" ${draft.total === "200" ? "selected" : ""}>200</option>
        </select>
        <label for="org">Tu nombre</label>
        <input id="org" name="organizer" required minlength="3" maxlength="80" value="${esc(draft.organizer)}" />
        <label for="fono">WhatsApp de contacto</label>
        <input id="fono" name="phone" required inputmode="tel" placeholder="+56 9 1234 5678" value="${esc(draft.phone)}" />
        <p class="ayuda">Sale en la rifa para que te escriban si tienen dudas.</p>
        <h2>Cuenta para la transferencia</h2>
        <label for="banco">Banco</label>
        <select id="banco" name="bank">
          ${BANKS.map((bank) => `<option value="${esc(bank)}" ${draft.bank === bank ? "selected" : ""}>${esc(bank)}</option>`).join("")}
        </select>
        <label for="otro-banco">Nombre del banco</label>
        <input id="otro-banco" name="bankOther" maxlength="40" placeholder="Solo si elegiste Otro" value="${esc(draft.bankOther)}" />
        <label for="tipo">Tipo de cuenta</label>
        <select id="tipo" name="accountType">
          ${ACCOUNT_TYPES.map((type) => `<option value="${esc(type)}" ${draft.accountType === type ? "selected" : ""}>${esc(type)}</option>`).join("")}
        </select>
        <label for="cuenta">Número de cuenta</label>
        <input id="cuenta" name="accountNumber" required inputmode="numeric" minlength="4" maxlength="20" value="${esc(draft.accountNumber)}" />
        <label for="rut">RUT del titular</label>
        <input id="rut" name="rut" required placeholder="12.345.678-5" value="${esc(draft.rut)}" />
        <label for="titular">Nombre del titular</label>
        <input id="titular" name="holder" required minlength="3" maxlength="80" value="${esc(draft.holder)}" />
        <p class="ayuda">Estos datos se muestran a quien compra, para que te transfiera directo.</p>
        <p class="honeypot" aria-hidden="true"><label>Empresa<input name="company" tabindex="-1" autocomplete="off" /></label></p>
        <button class="primario" type="submit" ${busy ? "disabled" : ""}>${busy ? "Creando…" : "Publicar rifa"}</button>
      </form>
    </section>`;
}

function transferInstructions(raffle, order) {
  if (!order) return "";
  const nums = (order.numbers || []).map((number) => pad(number, raffle.total_numbers)).join(", ");
  if (order.status === "paid") {
    return `<p class="ok">El organizador confirmó tu transferencia. Tus números: ${esc(nums)}.</p>`;
  }
  if (order.status === "failed") {
    return `<p class="alerta">El organizador liberó estos números. Si ya transferiste, escríbele por WhatsApp.</p>`;
  }
  if (order.status !== "reported" && order.status !== "pending") return "";
  return `<section class="panel bloque">
      <h2>Transfiere ${money(order.amount_clp)}</h2>
      <p>Números reservados por 48 horas: ${esc(nums)}. En el comentario de la transferencia escribe este código:</p>
      <p class="codigo">${esc(order.transfer_code || "")}</p>
      <p class="espera">${esc(timeLeft(order.reserved_until))}</p>
      <button type="button" class="claro" data-copy="${esc(order.transfer_code || "")}">Copiar código</button>
      <div class="cuenta">
        <div><span>Banco</span><strong>${esc(raffle.bank_name)}</strong></div>
        <div><span>Tipo</span><strong>${esc(raffle.account_type)}</strong></div>
        <div><span>Cuenta</span><strong>${esc(raffle.account_number)}</strong></div>
        <div><span>RUT</span><strong>${esc(raffle.account_rut)}</strong></div>
        <div><span>Titular</span><strong>${esc(raffle.account_holder)}</strong></div>
      </div>
      <button type="button" class="claro" data-copy="${esc(raffle.account_number)}">Copiar número de cuenta</button>
      <p class="ayuda">El número pasa a pagado cuando el organizador ve la transferencia en su cuenta.</p>
    </section>`;
}

function accountCard(raffle) {
  if (!raffle.account_number) return "";
  return `<section class="panel bloque">
      <h2>Transfieres a esta cuenta</h2>
      <div class="cuenta">
        <div><span>Banco</span><strong>${esc(raffle.bank_name)}</strong></div>
        <div><span>Tipo</span><strong>${esc(raffle.account_type)}</strong></div>
        <div><span>Cuenta</span><strong>${esc(raffle.account_number)}</strong></div>
        <div><span>RUT</span><strong>${esc(raffle.account_rut)}</strong></div>
        <div><span>Titular</span><strong>${esc(raffle.account_holder)}</strong></div>
      </div>
      <button type="button" class="claro" data-copy="${esc(raffle.account_number)}">Copiar número de cuenta</button>
      <p class="ayuda">El número queda pagado cuando ${esc(raffle.organizer_name)} confirma que llegó la transferencia.</p>
    </section>`;
}

function safeImage(url) {
  if (!url) return "";
  if (String(url).startsWith("https://") || String(url).startsWith("data:image/")) return String(url);
  return "";
}

function numberButtons(raffle, tickets) {
  const taken = new Map(tickets.map((ticket) => [Number(ticket.number), ticket.status]));
  const query = numberQuery.trim();
  return Array.from({ length: raffle.total_numbers }, (_, index) => index + 1)
    .filter((number) => {
      const state = taken.get(number);
      if (onlyFree && (state === "paid" || state === "reserved")) return false;
      if (!query) return true;
      return pad(number, raffle.total_numbers).includes(query) || String(number).includes(query);
    })
    .map((number) => {
      const state = selected.has(number) ? "elegido" : taken.get(number) === "paid" ? "pagado" : taken.get(number) === "reserved" ? "reservado" : "";
      const disabled = raffle.status !== "open" || state === "pagado" || state === "reservado";
      return `<button type="button" class="numero ${state} ${raffle.winner_number === number ? "ganador" : ""}" data-numero="${number}" ${disabled ? "disabled" : ""} aria-pressed="${selected.has(number)}">${pad(number, raffle.total_numbers)}</button>`;
    })
    .join("");
}

function raffleView(r, data) {
  const raffle = data.raffle;
  const tickets = data.tickets || [];
  const paidCount = tickets.filter((ticket) => ticket.status === "paid").length;
  const reservedCount = tickets.filter((ticket) => ticket.status === "reserved").length;
  const freeCount = raffle.total_numbers - paidCount - reservedCount;
  const pct = Math.round((paidCount / raffle.total_numbers) * 100);
  const open = raffle.status === "open";
  const numbers = numberButtons(raffle, tickets);
  const phone = digits(raffle.organizer_phone);
  const wa = `https://wa.me/${phone}?text=${encodeURIComponent(`Hola, te escribo por la rifa ${raffle.title}.`)}`;
  const share = `https://wa.me/?text=${encodeURIComponent(`Rifa: ${raffle.prize}. El número sale ${money(raffle.price_clp)}. Elige el tuyo aquí: ${publicUrl(raffle.id)}`)}`;
  const image = safeImage(raffle.prize_image_url);
  const when = formatWhen(raffle.draw_at);
  const winner = raffle.status === "drawn"
    ? `<section class="ganador ganador-pagina"><p>Número ganador</p><strong>${pad(raffle.winner_number, raffle.total_numbers)}</strong><p>Sorteado entre los números que alcanzaron a pagarse.</p></section>`
    : "";
  const totalSel = selected.size * raffle.price_clp;
  const picked = [...selected].sort((a, b) => a - b).map((number) => pad(number, raffle.total_numbers)).join(", ");
  const form = !raffle.account_number
    ? `<p class="alerta bloque">Esta rifa todavía no tiene una cuenta para transferir.</p>`
    : open && selected.size
    ? `<form id="form-pago" class="panel bloque">
        <h2>Tus datos</h2>
        ${errorMsg ? `<p class="alerta">${esc(errorMsg)}</p>` : ""}
        <p>Vas a transferir <strong>${money(totalSel)}</strong> a ${esc(raffle.account_holder)}, ${esc(raffle.bank_name)}.</p>
        <label for="nombre">Nombre</label>
        <input id="nombre" name="name" required minlength="3" maxlength="80" autocomplete="name" value="${esc(buyer.name)}" />
        <label for="correo">Correo</label>
        <input id="correo" name="email" type="email" required maxlength="120" autocomplete="email" value="${esc(buyer.email)}" />
        <label for="comprador">WhatsApp</label>
        <input id="comprador" name="phone" required inputmode="tel" autocomplete="tel" value="${esc(buyer.phone)}" />
        <button class="primario" type="submit" ${busy ? "disabled" : ""}>${busy ? "Reservando…" : "Reservar y ver datos para transferir"}</button>
        <p class="ayuda">Los números quedan tomados 48 horas. El organizador los marca pagados cuando ve la transferencia.</p>
      </form>`
    : "";
  return `${winner}
    <section class="portada">
      <div>
        <p class="estado">${esc(statusLabel(raffle.status))}</p>
        <h1>${esc(raffle.prize)}</h1>
        <p class="lead">${esc(raffle.title)}</p>
        <p class="precio">${money(raffle.price_clp)} <span class="muted">cada número</span></p>
        <p><strong>${freeCount} libres</strong> <span class="muted">de ${raffle.total_numbers}</span></p>
        ${when ? `<p class="muted">Sorteo: ${esc(when)}</p>` : ""}
      </div>
      ${image ? `<img class="premio-foto" alt="Foto del premio: ${esc(raffle.prize)}" src="${esc(image)}" />` : `<article class="boleto"><div class="sello">Nº</div><p class="premio">${esc(raffle.prize)}</p></article>`}
    </section>
    ${transferInstructions(raffle, data.order)}
    ${raffle.description ? `<p>${esc(raffle.description)}</p>` : ""}
    <p class="muted">Organiza ${esc(raffle.organizer_name)}. <a href="${esc(wa)}" target="_blank" rel="noopener">Escribir por WhatsApp</a></p>
    <div class="acciones">
      <a class="btn btn-claro" href="${esc(share)}" target="_blank" rel="noopener">Compartir por WhatsApp</a>
      <button type="button" class="claro" data-copy="${esc(publicUrl(raffle.id))}">Copiar enlace</button>
    </div>
    ${accountCard(raffle)}
    <section class="bloque">
      <div class="resumen"><strong>${paidCount} de ${raffle.total_numbers} pagados</strong><span>${pct}%</span></div>
      <div class="barra" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <div class="filtros">
        <button type="button" class="claro ${onlyFree ? "activo" : ""}" data-libres aria-pressed="${onlyFree}">Solo libres</button>
        <button type="button" class="claro" data-azar ${open ? "" : "disabled"}>Elegir al azar</button>
        <label class="buscar" for="buscar-numero">Buscar número
          <input id="buscar-numero" inputmode="numeric" maxlength="3" placeholder="15" value="${esc(numberQuery)}" />
        </label>
      </div>
      <div class="numeros">${numbers || `<p class="muted">No hay números con ese filtro.</p>`}</div>
      <p class="leyenda"><span><i class="punto libre"></i>Libre</span><span><i class="punto elegido"></i>Tu selección</span><span><i class="punto reservado"></i>Por confirmar</span><span><i class="punto pagado"></i>Pagado</span></p>
    </section>
    ${form}
    ${open && selected.size ? `<div class="paybar"><p><strong>${esc(picked)}</strong> · ${money(totalSel)}</p><a class="btn btn-primario" href="#form-pago">Continuar</a></div>` : ""}`;
}

function adminView(r, data) {
  const raffle = data.raffle;
  const orders = data.orders || [];
  const paid = orders.filter((order) => order.status === "paid");
  const numbersPaid = paid.reduce((sum, order) => sum + (order.numbers || []).length, 0);
  const collected = paid.reduce((sum, order) => sum + Number(order.amount_clp), 0);
  const waitingOrders = orders.filter((order) => order.status === "reported" || order.status === "pending");
  const paidOrders = orders.filter((order) => order.status === "paid");
  const card = (order) => {
    const nums = (order.numbers || []).map((number) => pad(number, raffle.total_numbers)).join(", ");
    const waiting = order.status === "reported" || order.status === "pending";
    return `<article class="tarjeta">
      <div class="compra">
        <div><strong>${esc(nums)}</strong><p>${esc(order.buyer_name)} · ${esc(order.buyer_email)}</p><p class="muted">${esc(showPhone(order.buyer_phone))}${order.transfer_code ? ` · código ${esc(order.transfer_code)}` : ""}</p></div>
        <strong>${money(order.amount_clp)}</strong>
      </div>
      ${waiting ? `<div class="acciones"><button type="button" class="primario" data-confirm="${esc(order.id)}">Confirmar pago</button><button type="button" class="claro" data-reject="${esc(order.id)}">Liberar número</button></div>` : ""}
    </article>`;
  };
  const controls = raffle.status === "drawn"
    ? ""
    : `<div class="acciones bloque">
        ${raffle.status === "open" ? `<button type="button" class="claro" data-status="closed">Cerrar ventas</button>` : `<button type="button" class="claro" data-status="open">Reabrir ventas</button>`}
        <button type="button" class="primario" data-draw>Sortear entre pagados</button>
      </div>`;
  return `<p class="alerta">Guarda este enlace. Es la llave para ver compradores y sortear, y no se puede recuperar si la pierdes.</p>
    <p class="estado">${esc(statusLabel(raffle.status))}</p>
    <h1>${esc(raffle.title)}</h1>
    <p class="lead">${esc(raffle.prize)}</p>
    ${raffle.status === "drawn" ? `<section class="ganador ganador-pagina"><p>Número ganador</p><strong>${pad(raffle.winner_number, raffle.total_numbers)}</strong></section>` : ""}
    ${errorMsg ? `<p class="alerta">${esc(errorMsg)}</p>` : ""}
    <div class="pasos">
      <article class="tarjeta"><strong>${numbersPaid}</strong><p class="muted">números pagados</p></article>
      <article class="tarjeta"><strong>${money(collected)}</strong><p class="muted">recaudado</p></article>
      <article class="tarjeta"><strong>${money(raffle.price_clp)}</strong><p class="muted">precio por número</p></article>
    </div>
    <div class="acciones bloque">
      <a class="btn btn-navy" href="${esc(publicUrl(raffle.id))}" data-go="raffle" data-id="${esc(raffle.id)}">Ver como comprador</a>
      <button type="button" class="claro" data-copy="${esc(publicUrl(raffle.id))}">Copiar enlace público</button>
      <button type="button" class="claro" data-csv>Descargar lista</button>
    </div>
    ${controls}
    <section class="bloque">
      <h2>Por confirmar</h2>
      <div class="lista">${waitingOrders.map(card).join("") || `<p class="muted">No hay transferencias esperando.</p>`}</div>
    </section>
    <section class="bloque">
      <h2>Pagados</h2>
      <div class="lista">${paidOrders.map(card).join("") || `<p class="muted">Todavía no hay números pagados.</p>`}</div>
    </section>`;
}

function view(r, data) {
  if (r.name === "home") return homeView(data);
  if (r.name === "create") return createView();
  if (r.name === "raffle") return raffleView(r, data);
  return adminView(r, data);
}

async function load(r) {
  if (r.name === "home") {
    return { mine: readMine(), sampleId: live ? null : demoLoad().raffles[0].id };
  }
  if (r.name === "create") return {};
  if (r.name === "raffle") {
    const data = await api.getRaffle(r.id);
    const order = r.orden ? await api.orderStatus(r.orden) : null;
    return { ...data, order };
  }
  return api.getAdmin(r.id, r.token);
}

function paint(scrollTop) {
  const r = route();
  if (r.name === "raffle" && cache?.tickets) {
    const taken = new Set(
      cache.tickets
        .filter((ticket) => ticket.status === "paid" || ticket.status === "reserved")
        .map((ticket) => Number(ticket.number)),
    );
    selected.forEach((number) => {
      if (taken.has(number)) selected.delete(number);
    });
  }
  const y = scrollTop ? 0 : window.scrollY;
  document.querySelector("#contenido").innerHTML = cache
    ? view(r, cache)
    : `<p class="cargando">Cargando…</p>`;
  document.body.classList.toggle("con-barra", Boolean(document.querySelector(".paybar")));
  document.title = r.name === "create"
    ? "Armar rifa · Rifa Online"
    : r.name === "raffle"
      ? `${cache?.raffle?.title || "Rifa"} · Rifa Online`
      : r.name === "admin"
        ? `Organizar · ${cache?.raffle?.title || "Rifa Online"}`
        : "Rifa Online";
  window.scrollTo(0, y);
}

function stopPoll() {
  clearInterval(pollTimer);
  pollTimer = 0;
}

function armPoll(r) {
  stopPoll();
  if (r.name !== "raffle" && r.name !== "admin") return;
  pollTimer = setInterval(async () => {
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
    const gen = renderGen;
    try {
      const fresh = await load(route());
      if (gen !== renderGen) return;
      cache = fresh;
      paint(false);
    } catch {
      // La siguiente visita muestra el error si la rifa dejó de cargar.
    }
  }, 8000);
}

async function render(scrollTop) {
  const gen = ++renderGen;
  stopPoll();
  const r = route();
  const key = dataKey(r);
  if (key !== cacheKey) {
    cache = null;
    cacheKey = key;
    buyer = { name: "", email: "", phone: "" };
    onlyFree = false;
    numberQuery = "";
    paint(true);
  }
  try {
    const fresh = await load(r);
    if (gen !== renderGen) return;
    cache = fresh;
    paint(scrollTop);
    armPoll(r);
  } catch (error) {
    if (gen !== renderGen) return;
    document.querySelector("#contenido").innerHTML = `<p class="alerta">${esc(error.message || "No se pudo cargar.")}</p>`;
  }
}

function readBuyer(form) {
  buyer = {
    name: form.name.value,
    email: form.email.value,
    phone: form.phone.value,
  };
  return buyer;
}

function downloadCsv(raffle, orders) {
  const lines = [["numero", "nombre", "correo", "telefono", "estado", "monto_clp"]];
  orders.forEach((order) => {
    (order.numbers || []).forEach((number) => {
      lines.push([
        number,
        order.buyer_name,
        order.buyer_email,
        order.buyer_phone || "",
        order.status,
        order.amount_clp,
      ]);
    });
  });
  const csv = lines
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${raffle.title.slice(0, 40)}-compradores.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

document.body.addEventListener("click", async (event) => {
  const link = event.target.closest("[data-go]");
  if (link) {
    event.preventDefault();
    if (link.dataset.go === "home") go({});
    else if (link.dataset.go === "create") go({ nueva: "1" });
    else if (link.dataset.go === "raffle") go({ rifa: link.dataset.id });
    else if (link.dataset.go === "admin") go({ admin: link.dataset.id, clave: link.dataset.token });
    return;
  }

  const copy = event.target.closest("[data-copy]");
  if (copy) {
    copyText(copy.dataset.copy);
    return;
  }

  if (event.target.closest("[data-libres]")) {
    onlyFree = !onlyFree;
    paint(false);
    return;
  }

  if (event.target.closest("[data-azar]") && cache?.raffle?.status === "open") {
    const taken = new Set(
      (cache.tickets || [])
        .filter((ticket) => ticket.status === "paid" || ticket.status === "reserved")
        .map((ticket) => Number(ticket.number)),
    );
    const free = [];
    for (let number = 1; number <= cache.raffle.total_numbers; number += 1) {
      if (!taken.has(number) && !selected.has(number)) free.push(number);
    }
    if (!free.length) aviso("No quedan números libres.");
    else if (selected.size >= 15) aviso("Puedes llevar hasta 15 números por reserva.");
    else {
      const bytes = new Uint32Array(1);
      crypto.getRandomValues(bytes);
      selected.add(free[bytes[0] % free.length]);
      paint(false);
    }
    return;
  }

  const number = event.target.closest("[data-numero]");
  if (number && cache?.raffle?.status === "open") {
    const value = Number(number.dataset.numero);
    if (selected.has(value)) selected.delete(value);
    else if (selected.size < 15) selected.add(value);
    else aviso("Puedes llevar hasta 15 números por reserva.");
    errorMsg = "";
    paint(false);
    return;
  }

  const statusBtn = event.target.closest("[data-status]");
  if (statusBtn && cache?.raffle) {
    const r = route();
    busy = true;
    try {
      await api.setStatus(r.id, r.token, statusBtn.dataset.status);
      cache = await load(r);
      paint(false);
    } catch (error) {
      errorMsg = error.message;
      paint(false);
    } finally {
      busy = false;
    }
    return;
  }

  const orderAction = event.target.closest("[data-confirm], [data-reject]");
  if (orderAction && cache?.raffle) {
    const orderId = orderAction.dataset.confirm || orderAction.dataset.reject;
    const confirming = Boolean(orderAction.dataset.confirm);
    const ok = confirm(confirming
      ? "¿Ya viste esta transferencia en tu cuenta?"
      : "¿Liberar estos números para que otra persona pueda tomarlos?");
    if (!ok) return;
    const r = route();
    try {
      if (confirming) await api.confirmOrder(r.id, r.token, orderId);
      else await api.rejectOrder(r.id, r.token, orderId);
      cache = await load(r);
      errorMsg = "";
      paint(false);
    } catch (error) {
      errorMsg = error.message;
      paint(false);
    }
    return;
  }

  if (event.target.closest("[data-draw]")) {
    const ok = confirm("Se elige un número al azar entre los pagados y la rifa queda cerrada. ¿Sortear ahora?");
    if (!ok) return;
    const r = route();
    try {
      await api.draw(r.id, r.token);
      cache = await load(r);
      errorMsg = "";
      paint(true);
    } catch (error) {
      errorMsg = error.message;
      paint(false);
    }
    return;
  }

  if (event.target.closest("[data-csv]") && cache?.raffle) {
    downloadCsv(cache.raffle, cache.orders || []);
  }
});

document.body.addEventListener("input", (event) => {
  if (event.target.id === "buscar-numero") {
    numberQuery = event.target.value;
    const box = document.querySelector(".numeros");
    if (box && cache?.raffle) box.innerHTML = numberButtons(cache.raffle, cache.tickets || []) || `<p class="muted">No hay números con ese filtro.</p>`;
    return;
  }
  const form = event.target.closest("#form-pago");
  if (!form) return;
  buyer = {
    name: form.name.value,
    email: form.email.value,
    phone: form.phone.value,
  };
});

document.body.addEventListener("change", async (event) => {
  if (event.target.id !== "foto") return;
  const file = event.target.files?.[0];
  const form = event.target.form;
  if (!file || !form) return;
  try {
    const image = await compressImage(file);
    draft = {
      title: form.title.value,
      prize: form.prize.value,
      description: form.description.value,
      price: form.price.value,
      total: form.total.value,
      organizer: form.organizer.value,
      phone: form.phone.value,
      bank: form.bank.value,
      bankOther: form.bankOther.value,
      accountType: form.accountType.value,
      accountNumber: form.accountNumber.value,
      rut: form.rut.value,
      holder: form.holder.value,
      prizeImage: image,
      drawAt: form.drawAt.value,
    };
    if (image.length > 200000) {
      errorMsg = "La foto quedó muy pesada. Elige una más chica.";
      draft.prizeImage = "";
    } else {
      errorMsg = "";
    }
    paint(false);
  } catch (error) {
    errorMsg = error.message;
    paint(false);
  }
});

document.body.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id === "form-rifa") {
    event.preventDefault();
    if (form.company.value) return;
    draft = {
      title: form.title.value,
      prize: form.prize.value,
      description: form.description.value,
      price: form.price.value,
      total: form.total.value,
      organizer: form.organizer.value,
      phone: form.phone.value,
      bank: form.bank.value,
      bankOther: form.bankOther.value,
      accountType: form.accountType.value,
      accountNumber: form.accountNumber.value,
      rut: form.rut.value,
      holder: form.holder.value,
      prizeImage: draft.prizeImage,
      drawAt: form.drawAt.value,
    };
    const image = (draft.prizeImage || "").trim();
    if (image && image.length > 200000) {
      errorMsg = "La foto quedó muy pesada. Elige una más chica.";
      paint(false);
      return;
    }
    if (draft.drawAt && Number.isNaN(new Date(draft.drawAt).getTime())) {
      errorMsg = "La fecha del sorteo no es válida.";
      paint(false);
      return;
    }
    const bankName = draft.bank === "Otro" ? draft.bankOther.trim() : draft.bank;
    if (!validRut(draft.rut)) {
      errorMsg = "El RUT de la cuenta no es válido.";
      paint(false);
      return;
    }
    if (digits(draft.accountNumber).length < 4) {
      errorMsg = "Escribe el número de cuenta, solo dígitos.";
      paint(false);
      return;
    }
    if (bankName.length < 3) {
      errorMsg = "Escribe el nombre del banco.";
      paint(false);
      return;
    }
    const input = {
      title: draft.title.trim(),
      prize: draft.prize.trim(),
      description: draft.description.trim(),
      price_clp: Number(draft.price),
      total_numbers: Number(draft.total),
      organizer_name: draft.organizer.trim(),
      organizer_phone: chilePhone(draft.phone),
      bank_name: bankName,
      account_type: draft.accountType,
      account_number: digits(draft.accountNumber),
      account_rut: formatRut(draft.rut),
      account_holder: draft.holder.trim(),
      prize_image_url: image,
      draw_at: draft.drawAt ? new Date(draft.drawAt).toISOString() : null,
    };
    if (input.organizer_phone.length < 8) {
      errorMsg = "Escribe un WhatsApp con código de país, por ejemplo +56 9 1234 5678.";
      paint(false);
      return;
    }
    busy = true;
    errorMsg = "";
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "Creando…";
    try {
      const created = await api.createRaffle(input);
      remember({
        id: created.id,
        token: created.admin_token,
        title: input.title,
        prize: input.prize,
      });
      history.pushState({}, "", `${location.pathname}?admin=${encodeURIComponent(created.id)}&clave=${encodeURIComponent(created.admin_token)}`);
      busy = false;
      render(true);
    } catch (error) {
      busy = false;
      errorMsg = error.message;
      paint(false);
    }
    return;
  }

  if (form.id === "form-pago") {
    event.preventDefault();
    const draft = readBuyer(form);
    if (chilePhone(draft.phone).length < 8) {
      errorMsg = "Escribe tu WhatsApp para coordinar el premio.";
      paint(false);
      return;
    }
    const r = route();
    busy = true;
    errorMsg = "";
    paint(false);
    try {
      const result = await api.checkout({
        raffleId: r.id,
        numbers: [...selected].sort((a, b) => a - b),
        buyerName: draft.name.trim(),
        buyerEmail: draft.email.trim(),
        buyerPhone: chilePhone(draft.phone),
      });
      selected = new Set();
      buyer = { name: "", email: "", phone: "" };
      busy = false;
      history.replaceState({}, "", `${location.pathname}?rifa=${encodeURIComponent(r.id)}&orden=${encodeURIComponent(result.orderId)}`);
      cache = await load({ ...r, orden: result.orderId });
      paint(true);
      aviso("Números reservados. Transfiere usando el código que aparece arriba.");
    } catch (error) {
      busy = false;
      errorMsg = error.message;
      cache = await load(r);
      paint(false);
    }
  }
});

window.addEventListener("popstate", () => {
  selected = new Set();
  errorMsg = "";
  render(true);
});

const modo = document.querySelector("#modo");
if (!live) {
  modo.hidden = false;
  modo.textContent = "Modo demostración: puedes recorrer la rifa. Las transferencias no son reales hasta conectar Supabase.";
}

render(true);
