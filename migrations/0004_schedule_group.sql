-- Черга для графіка відключень у SvitloPulse, наприклад dtek-kem:20.1 (задається командою /queue)
ALTER TABLE state ADD COLUMN schedule_group TEXT;
