import { AuthShell } from "../../_components/auth-shell";
import { ChangePasswordForm } from "../../_components/auth-forms";
import { requireUser } from "../../_lib/session";

export default async function ChangePasswordPage() {
  await requireUser();
  return (
    <AuthShell kind="change-password">
      <ChangePasswordForm />
    </AuthShell>
  );
}
