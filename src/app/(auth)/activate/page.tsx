import { AuthShell } from "../../_components/auth-shell";
import { ResetForm } from "../../_components/auth-forms";

export default function ActivatePage() {
  return (
    <AuthShell kind="activate">
      <ResetForm kind="activate" />
    </AuthShell>
  );
}
