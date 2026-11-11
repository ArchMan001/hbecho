// 停用 / 恢复 / 强制下线：列表与详情共用的三个确认弹窗（文案来自已确认原型，影响范围写明，按钮写动作名）。
import { disableUser, forceLogoutUser, restoreUser } from "../_actions/users";
import { ConfirmAction } from "./dialog";
import { Callout } from "./ui";

export function DisableButton({ id, name, header = false }: { id: string; name: string; header?: boolean }) {
  return (
    <ConfirmAction
      label="停用"
      icon={header ? "lock" : undefined}
      buttonClass={header ? "btn btn-danger" : "btn btn-sm"}
      title="停用用户"
      confirmLabel="停用用户"
      danger
      action={disableUser.bind(null, id)}
      doneMessage={`已停用 ${name}，现有会话已失效`}
    >
      <p className="hint" style={{ marginBottom: 12 }}>
        用户：<strong>{name}</strong>
      </p>
      <Callout icon="lock" tone="danger">
        停用后：该用户的现有会话全部失效；登录手机号不再占用，可由别人使用；取消该用户触发的未完成异步任务；记审计。原手机号仍保留在授权记录里。
      </Callout>
      <p className="hint" style={{ marginTop: 12 }}>高风险操作与审计同一事务；审计写入失败会整体回滚。</p>
    </ConfirmAction>
  );
}

export function RestoreButton({ id, name, header = false }: { id: string; name: string; header?: boolean }) {
  return (
    <ConfirmAction
      label="恢复"
      icon={header ? "play" : undefined}
      buttonClass={header ? "btn" : "btn btn-sm"}
      title="恢复用户"
      confirmLabel="恢复用户"
      action={restoreUser.bind(null, id)}
      doneMessage={`已恢复 ${name}`}
    >
      <p className="hint" style={{ marginBottom: 12 }}>
        用户：<strong>{name}</strong>
      </p>
      <Callout icon="check">
        恢复前重新检查角色、品牌、分公司与关联的专员；已不存在或无法对应的项直接去掉并记审计。品牌或组织停用不算失效。恢复前会复核手机号没有被别人占用。
      </Callout>
    </ConfirmAction>
  );
}

export function ForceLogoutButton({ id, name }: { id: string; name: string }) {
  return (
    <ConfirmAction
      label="强制下线"
      icon="logout"
      buttonClass="btn"
      title="强制下线"
      confirmLabel="强制下线"
      danger
      action={forceLogoutUser.bind(null, id)}
      doneMessage={`${name} 的全部会话已失效`}
    >
      <p className="hint">
        撤销 <strong>{name}</strong> 的全部会话并记审计；不改变用户的角色与状态。对方需要重新登录。
      </p>
    </ConfirmAction>
  );
}
