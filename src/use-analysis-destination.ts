import { useEffect, useState } from "react";

import type { AnalysisDestination } from "../common/analysis-provider";

/**
 * Where Analyze sends recording data (GitHub Copilot or the user's own provider), kept
 * current when Settings is saved in any window. null until the first answer arrives.
 */
export function useAnalysisDestination(): AnalysisDestination | null {
  const [destination, setDestination] = useState<AnalysisDestination | null>(null);

  useEffect(() => {
    let live = true;
    window.skillRecorder
      .analysisProviderStatus()
      .then((status) => {
        if (live) setDestination(status.destination);
      })
      .catch(() => {
        // Leave the copy generic rather than name a destination that may be wrong.
      });
    const unsubscribe = window.skillRecorder.onAnalysisProviderChanged((status) =>
      setDestination(status.destination),
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return destination;
}
