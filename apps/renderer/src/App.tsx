import { useEffect, useRef } from "react";

import ChatView from "./components/ChatView";
import DiffPanel from "./components/DiffPanel";
import Sidebar from "./components/Sidebar";
import { readNativeApi } from "./session-logic";
import { StoreProvider, useStore } from "./store";

function EventRouter() {
  const api = readNativeApi();
  const { dispatch } = useStore();
  const activeAssistantItemRef = useRef<string | null>(null);

  useEffect(() => {
    if (!api) return;
    return api.providers.onEvent((event) => {
      dispatch({
        type: "APPLY_EVENT",
        event,
        activeAssistantItemRef,
      });
    });
  }, [api, dispatch]);

  return null;
}

function BootstrapRouter() {
  const api = readNativeApi();
  const { dispatch } = useStore();

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.app
      .bootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        dispatch({
          type: "BOOTSTRAP_FROM_SERVER",
          bootstrap,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        dispatch({
          type: "SET_RUNTIME_ERROR",
          error:
            error instanceof Error
              ? error.message
              : "Could not connect to the local t3 runtime.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [api, dispatch]);

  return null;
}

function Layout() {
  const api = readNativeApi();
  const { state } = useStore();

  if (!api) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="drag-region h-[52px] shrink-0" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Local t3 runtime unavailable.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <BootstrapRouter />
      <EventRouter />
      {state.runtimeError && state.projects.length === 0 && (
        <div className="pointer-events-none fixed right-4 top-4 z-50 max-w-[440px] rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
          Runtime connection failed: {state.runtimeError}
        </div>
      )}
      <Sidebar />
      <ChatView />
      {state.diffOpen && <DiffPanel />}
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Layout />
    </StoreProvider>
  );
}
