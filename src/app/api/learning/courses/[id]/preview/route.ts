import { getAccessRuntime } from "../../../../../../modules/access-control/runtime";
import { createPreviewHandler } from "../../../../../../modules/learning";
import { learning } from "../../../../../_lib/learning";

export const dynamic = "force-dynamic";
export const GET = async (req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
  const rt = getAccessRuntime();
  return createPreviewHandler({ authenticate: (h) => rt.web.authenticate(h), deps: learning })(req, (await params).id);
};
