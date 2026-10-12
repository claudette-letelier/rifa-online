-- Foto del premio y fecha del sorteo.
-- Ejecutar en el SQL Editor después de 002_transferencia.sql.

alter table public.raffles
  add column if not exists prize_image_url text,
  add column if not exists draw_at timestamptz;

drop view if exists public.raffle_public;
create view public.raffle_public
with (security_invoker = false) as
select
  id,
  title,
  prize,
  description,
  price_clp,
  total_numbers,
  organizer_name,
  organizer_phone,
  bank_name,
  account_type,
  account_number,
  account_rut,
  account_holder,
  prize_image_url,
  draw_at,
  status,
  winner_number,
  drawn_at,
  created_at
from public.raffles;

grant select on public.raffle_public to anon, authenticated;

drop function if exists public.create_raffle(text, text, text, integer, integer, text, text, text, text, text, text, text);

create or replace function public.create_raffle(
  p_title text,
  p_prize text,
  p_description text,
  p_price integer,
  p_total integer,
  p_organizer_name text,
  p_organizer_phone text,
  p_bank_name text,
  p_account_type text,
  p_account_number text,
  p_account_rut text,
  p_account_holder text,
  p_prize_image text,
  p_draw_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid := gen_random_uuid();
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_phone text := regexp_replace(coalesce(p_organizer_phone, ''), '[^0-9]', '', 'g');
  v_account text := regexp_replace(coalesce(p_account_number, ''), '[^0-9]', '', 'g');
  v_image text := nullif(trim(coalesce(p_prize_image, '')), '');
begin
  if char_length(trim(coalesce(p_title, ''))) < 3
     or char_length(trim(coalesce(p_prize, ''))) < 3
     or char_length(trim(coalesce(p_organizer_name, ''))) < 3
     or char_length(v_phone) < 8
     or p_price < 1000 or p_price > 200000
     or p_total < 10 or p_total > 300 then
    raise exception 'invalid_raffle';
  end if;
  if char_length(trim(coalesce(p_bank_name, ''))) < 3
     or char_length(trim(coalesce(p_bank_name, ''))) > 40
     or p_account_type not in ('Cuenta RUT', 'Cuenta vista', 'Cuenta corriente', 'Cuenta de ahorro')
     or char_length(v_account) < 4
     or char_length(v_account) > 20
     or char_length(trim(coalesce(p_account_holder, ''))) < 3 then
    raise exception 'invalid_bank';
  end if;
  if not public.rut_valido(p_account_rut) then
    raise exception 'invalid_rut';
  end if;
  if v_image is not null
     and v_image !~ '^https://'
     and v_image !~ '^data:image/(jpeg|png|webp);base64,' then
    raise exception 'invalid_image';
  end if;
  if v_image is not null and char_length(v_image) > 200000 then
    raise exception 'invalid_image';
  end if;

  insert into public.raffles (
    id, title, prize, description, price_clp, total_numbers,
    organizer_name, organizer_phone, admin_token_hash,
    bank_name, account_type, account_number, account_rut, account_holder,
    prize_image_url, draw_at
  ) values (
    v_id,
    trim(p_title),
    trim(p_prize),
    left(trim(coalesce(p_description, '')), 500),
    p_price,
    p_total,
    trim(p_organizer_name),
    v_phone,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    trim(p_bank_name),
    p_account_type,
    v_account,
    public.format_rut(p_account_rut),
    trim(p_account_holder),
    v_image,
    p_draw_at
  );

  return jsonb_build_object('id', v_id, 'admin_token', v_token);
end;
$$;

create or replace function public.order_status(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'status', o.status,
    'raffle_id', o.raffle_id,
    'amount_clp', o.amount_clp,
    'transfer_code', o.transfer_code,
    'reserved_until', o.reserved_until,
    'numbers', coalesce(
      (select jsonb_agg(t.number order by t.number) from public.tickets t where t.order_id = o.id),
      '[]'::jsonb
    )
  )
  from public.orders o
  where o.id = p_order_id;
$$;

revoke all on function public.create_raffle(text, text, text, integer, integer, text, text, text, text, text, text, text, text, timestamptz) from public;
grant execute on function public.create_raffle(text, text, text, integer, integer, text, text, text, text, text, text, text, text, timestamptz) to anon, authenticated;
