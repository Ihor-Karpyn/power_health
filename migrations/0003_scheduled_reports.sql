-- Дата (за Києвом, YYYY-MM-DD), коли востаннє надіслали звіт, щоб не дублювати
ALTER TABLE state ADD COLUMN last_weekly_report TEXT;
ALTER TABLE state ADD COLUMN last_monthly_report TEXT;
