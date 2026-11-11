import { getAccessRuntime } from "../../../../modules/access-control/runtime";
import { createProgressHandler } from "../../../../modules/learning";
import { learning } from "../../../_lib/learning";

export const dynamic = "force-dynamic";
export const POST = (req: Request): Promise<Response> => {
  const rt = getAccessRuntime();
  return createProgressHandler({ authenticate: (h) => rt.web.authenticate(h), deps: learning, trustedOrigins: rt.config.trustedOrigins })(req);
};
