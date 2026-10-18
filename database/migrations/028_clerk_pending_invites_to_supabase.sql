-- Preserve pending invitations created before the authentication-provider migration.
-- Only placeholder identities are converted; established Clerk user identities are untouched.
do $migration$
begin
  if exists (
    select 1
    from users legacy_invite
    join users supabase_invite
      on supabase_invite.auth_provider = 'supabase'
     and supabase_invite.external_subject = legacy_invite.external_subject
    where legacy_invite.auth_provider = 'clerk'
      and legacy_invite.external_subject like 'invite:%'
  ) then
    raise exception 'Cannot migrate Clerk invitations: a Supabase invitation already uses the same identity';
  end if;

  if exists (
    select lower(email)
    from users
    where auth_provider in ('clerk', 'supabase')
      and external_subject like 'invite:%'
      and email is not null
    group by lower(email)
    having count(*) > 1
  ) then
    raise exception 'Cannot migrate Clerk invitations: duplicate pending invitation emails exist';
  end if;
end;
$migration$;

update users
set auth_provider = 'supabase'
where auth_provider = 'clerk'
  and external_subject like 'invite:%';
