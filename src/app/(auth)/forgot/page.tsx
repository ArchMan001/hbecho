import { AuthShell } from "../../_components/auth-shell";
import { ResetForm } from "../../_components/auth-forms";

export default function ForgotPage() {
  return (
    <AuthShell kind="forgot">
      <ResetForm kind="forgot" />
    </AuthShell>
  );
}
