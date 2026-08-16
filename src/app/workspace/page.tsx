import { Suspense } from "react";
import { WorkspaceClient } from "./WorkspaceClient";

export default function WorkspacePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-sm text-ink-500">
          正在唤醒工作区…
        </div>
      }
    >
      <WorkspaceClient />
    </Suspense>
  );
}
