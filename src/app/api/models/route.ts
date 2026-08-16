import { defaultModel, raceModels } from "@/lib/llm";

export const runtime = "nodejs";

/** 可选模型池。网关上游可能挂着上百个模型,这里只暴露经过验证的几个。 */
export async function GET() {
  const options = Array.from(new Set([defaultModel(), ...raceModels()]));
  return Response.json({ default: defaultModel(), options });
}
