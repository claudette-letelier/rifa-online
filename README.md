# Rifa Online

Sitio para armar una rifa, compartir un enlace y cobrar los números con Mercado Pago en pesos chilenos. La página pública se hospeda en GitHub Pages. Los números y los pagos viven en Supabase, porque GitHub Pages no puede guardar una reserva ni esconder la clave de Mercado Pago.

Mientras `site/js/config.js` esté vacío, el sitio abre en modo demostración: se puede crear una rifa y marcar números, pero no se cobra dinero real.

## Publicar la página

1. Sube este repositorio a GitHub.
2. En el repositorio: Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. El workflow publica la carpeta `site` en cada push a `main`.

La dirección queda como `https://TU-USUARIO.github.io/rifa-online/`.

## Conectar los pagos

1. Crea un proyecto en [Supabase](https://supabase.com) y, en el SQL Editor, ejecuta `supabase/migrations/001_rifa.sql`.
2. En Mercado Pago Chile crea una aplicación y copia el **Access Token** de producción.
3. Instala la [CLI de Supabase](https://supabase.com/docs/guides/cli), entra al proyecto y publica las funciones:

```bash
supabase link --project-ref TU_PROJECT_REF
supabase secrets set MP_ACCESS_TOKEN=tu_access_token
supabase secrets set SITE_URL=https://TU-USUARIO.github.io/rifa-online
supabase functions deploy create-checkout
supabase functions deploy mp-webhook --no-verify-jwt
```

4. En Supabase → Project Settings → API, copia la URL y la clave `anon`.
5. Pégalas en `site/js/config.js` junto con el nombre de quien recibe el dinero:

```js
window.RIFA_CONFIG = {
  supabaseUrl: "https://xxxx.supabase.co",
  supabaseAnonKey: "eyJ...",
  collectorName: "Junta de vecinos Los Aromos",
};
```

6. Haz commit y push. El dinero de todas las rifas de este sitio entra a esa cuenta de Mercado Pago.

Cada organizador que quiera recibir el dinero en su propia cuenta puede clonar el repositorio y poner su token.

## Cómo se usa

- **Armar rifa** crea el enlace público (para compartir por WhatsApp) y el enlace privado de organización. Ese enlace privado no se puede recuperar: guárdalo.
- La persona elige hasta 15 números. Quedan reservados 20 minutos mientras paga.
- Al aprobarse el pago, Mercado Pago avisa al sitio y el número pasa a pagado.
- En organizar se ve quién compró, se descarga la lista y se sortea al azar entre los números pagados. El sorteo no se puede repetir.

Quien publica la rifa es responsable del premio y de las reglas que apliquen en Chile.
