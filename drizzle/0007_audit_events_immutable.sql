-- audit_events 追加写（b-access-control design §6.1、AX-D15）：
--   UPDATE 一律拒绝；DELETE 仅放行超过 365 天的行（到期清理），其余拒绝。
-- 触发器依赖部署账号的 TRIGGER 权限（design §12，由运维手册登记）。TRUNCATE 不触发 DELETE 触发器，仅测试挂具使用。
CREATE TRIGGER `trg_audit_events_no_update` BEFORE UPDATE ON `audit_events` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events is append-only: UPDATE is not allowed';
END;
--> statement-breakpoint
CREATE TRIGGER `trg_audit_events_delete_guard` BEFORE DELETE ON `audit_events` FOR EACH ROW
BEGIN
  IF OLD.occurred_at >= UTC_TIMESTAMP(6) - INTERVAL 365 DAY THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events is append-only: rows younger than 365 days cannot be deleted';
  END IF;
END;
