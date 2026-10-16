revoke execute on function public.is_team() from public;
revoke execute on function public.is_team() from anon;
grant execute on function public.is_team() to authenticated;
