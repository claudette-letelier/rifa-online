# Rifa Online

Sitio para armar una rifa, compartir un enlace y recibir el pago por transferencia a la cuenta de quien creó esa rifa. La página pública se hospeda en GitHub Pages. Los números viven en Supabase, porque GitHub Pages no puede reservar un número para dos personas a la vez.

Mientras `site/js/config.js` esté vacío, el sitio abre en modo demostración.

## Publicar la página

1. Sube este repositorio a GitHub.
2. En el repositorio: Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. El workflow publica la carpeta `site` en cada push a `main`.

La dirección queda como `https://TU-USUARIO.github.io/rifa-online/`.

## Conectar Supabase

1. Crea un proyecto en [Supabase](https://supabase.com).
2. En el SQL Editor ejecuta, en orden, `supabase/migrations/001_rifa.sql`, `002_transferencia.sql` y `003_portada.sql`. Si las primeras ya corrieron, basta con ejecutar las que falten.
3. En Project Settings → API, copia la URL y la clave `anon` en `site/js/config.js`:

```js
window.RIFA_CONFIG = {
  supabaseUrl: "https://xxxx.supabase.co",
  supabaseAnonKey: "eyJ...",
};
```

4. Haz commit y push.

## Cómo se usa

- **Armar rifa** pide el premio y la cuenta donde deben transferir (banco, tipo, número, RUT y titular). Devuelve un enlace público y otro privado de organización. El privado no se puede recuperar: guárdalo.
- La persona elige hasta 15 números y los reserva por 48 horas. Ve el monto, la cuenta y un código para poner en el comentario de la transferencia.
- En el enlace privado, el organizador confirma el pago cuando ve la plata, o libera el número si no llegó. Solo los números confirmados entran al sorteo.
- El sorteo elige al azar entre los números pagados y no se puede repetir.

Quien publica la rifa es responsable del premio, de revisar su cartola y de las reglas que apliquen en Chile.
