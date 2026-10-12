Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "retired",
      message: "El cobro es por transferencia a la cuenta del organizador. Esta función ya no se usa.",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);
