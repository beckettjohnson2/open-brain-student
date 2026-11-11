-- Hide two leftover messages (owner's OK, Nov 11). Archive only, nothing deleted.
--   8544b68e… "Delete that"
--   6933dc17… "Look up the videos and find the link and transcripts and add them"
update public.thoughts
set status = 'archived'
where id in ('8544b68e-9116-48f4-853c-6a104f388764', '6933dc17-7686-4c12-848b-1190ae52ea9d')
  and status is distinct from 'archived'
returning id, status, left(content, 60) as content;
