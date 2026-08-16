import { ReplayClient } from "./ReplayClient";

export default async function ReplayPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <ReplayClient runId={runId} />;
}
