import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import { PairingRouteSurface } from "../components/auth/PairingRouteSurface";
import { resolveInitialServerAuthGateState } from "../authBootstrap";

export const Route = createFileRoute("/pair")({
  beforeLoad: async () => {
    const authGateState = await resolveInitialServerAuthGateState();
    if (authGateState.status === "authenticated") {
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
});

function PairRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();

  if (!authGateState) {
    return null;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        void navigate({ to: "/", replace: true });
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}
