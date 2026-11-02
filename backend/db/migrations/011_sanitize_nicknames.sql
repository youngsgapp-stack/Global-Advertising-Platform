-- Public display names: stop showing full email addresses and strip HTML-significant characters

UPDATE users
SET nickname = split_part(nickname, '@', 1)
WHERE nickname LIKE '%@%';

UPDATE users
SET nickname = COALESCE(NULLIF(btrim(regexp_replace(nickname, '[[:cntrl:]<>"''`&]', '', 'g')), ''), 'User')
WHERE nickname ~ '[[:cntrl:]<>"''`&]';

UPDATE territories t
SET ruler_name = u.nickname
FROM users u
WHERE t.ruler_id = u.id
  AND t.ruler_name IS DISTINCT FROM u.nickname
  AND (t.ruler_name LIKE '%@%' OR t.ruler_name ~ '[[:cntrl:]<>"''`&]');
