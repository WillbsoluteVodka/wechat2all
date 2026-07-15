import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import QRCode from "qrcode";

import {
  getDashboardSnapshot,
  getLoginStatus,
  requestQrLogin,
  unlinkWechatSession,
} from "./api";
import { AgentsPage, TracePage } from "./pages/ConstructionPages";
import { ConfigPage } from "./pages/ConfigPage";
import { HomePage } from "./pages/HomePage";
import { RoutesPage } from "./pages/RoutesPage";
import type {
  DashboardSnapshot,
  LoginStatus,
  PageKey,
  QrLoginResponse,
} from "./types";
import { CoreConsole, PixelClickBurstLayer, WindowDragRegion } from "./ui/AppChrome";
import { EmptyState } from "./ui/Common";
import { PixelStartupGate } from "./ui/StartupGate";

export function App() {
  const [startupDismissed, setStartupDismissed] = useState(false);
  const [startupOverlayVisible, setStartupOverlayVisible] = useState(true);
  const [activePage, setActivePage] = useState<PageKey>("home");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [qr, setQr] = useState<QrLoginResponse | null>(null);
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoQrProfileRef = useRef<string | null>(null);

  function handleShellPointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    event.currentTarget.style.setProperty("--pointer-x", `${Math.round(x * 100)}%`);
    event.currentTarget.style.setProperty("--pointer-y", `${Math.round(y * 100)}%`);
    event.currentTarget.style.setProperty("--tilt-x", `${(0.5 - y) * 8}deg`);
    event.currentTarget.style.setProperty("--tilt-y", `${(x - 0.5) * 10}deg`);
  }

  function handleShellPointerLeave(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.style.setProperty("--pointer-x", "72%");
    event.currentTarget.style.setProperty("--pointer-y", "18%");
    event.currentTarget.style.setProperty("--tilt-x", "0deg");
    event.currentTarget.style.setProperty("--tilt-y", "0deg");
  }

  useEffect(() => {
    let cancelled = false;
    getDashboardSnapshot()
      .then((data) => {
        if (!cancelled) setSnapshot(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedRouteStillExists = useMemo(
    () => snapshot?.routes.some((route) => route.id === selectedRouteId) ?? false,
    [snapshot, selectedRouteId],
  );

  useEffect(() => {
    if (selectedRouteId && !selectedRouteStillExists) {
      setSelectedRouteId(null);
    }
  }, [selectedRouteId, selectedRouteStillExists]);

  useEffect(() => {
    if (startupOverlayVisible) return undefined;
    if (activePage !== "home" && activePage !== "routes" && activePage !== "trace") {
      return undefined;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const data = await getDashboardSnapshot();
        if (!cancelled) setSnapshot(data);
      } catch {
        // Keep the last good snapshot visible if the local daemon restarts.
      }
    };

    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activePage, startupOverlayVisible]);

  useEffect(() => {
    if (!snapshot || !qr) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getLoginStatus(snapshot.profile.id);
        if (cancelled) return;
        setLoginStatus(status);
        if (status.status === "confirmed") {
          setQr(null);
          setQrImage(null);
          autoQrProfileRef.current = null;
          setSnapshot(await getDashboardSnapshot());
        }
        if (status.error) {
          setQrError(status.error);
        }
      } catch (err) {
        if (!cancelled) {
          setQrError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [snapshot?.profile.id, qr]);

  const requestQr = useCallback(async () => {
    const profileId = snapshot?.profile.id;
    if (!profileId) return;
    setQrError(null);
    setQrImage(null);
    setLoginStatus(null);
    try {
      const response = await requestQrLogin(profileId);
      setQr(response);
      setQrImage(await QRCode.toDataURL(response.qrPayload, {
        width: 320,
        margin: 2,
        errorCorrectionLevel: "M",
        color: {
          dark: "#0b1012",
          light: "#f4f8f6",
        },
      }));
    } catch (err) {
      setQrError(err instanceof Error ? err.message : String(err));
    }
  }, [snapshot?.profile.id]);

  useEffect(() => {
    if (startupOverlayVisible || activePage !== "home" || !snapshot) return;
    if (snapshot.profile.connected || qr || qrError) return;
    if (autoQrProfileRef.current === snapshot.profile.id) return;
    autoQrProfileRef.current = snapshot.profile.id;
    void requestQr();
  }, [activePage, qr, qrError, requestQr, snapshot, startupOverlayVisible]);

  const completeStartup = useCallback(() => {
    setStartupDismissed(true);
    setStartupOverlayVisible(false);
  }, []);

  const beginStartupDocking = useCallback(() => {
    setStartupDismissed(true);
  }, []);

  const startupGate = startupOverlayVisible ? (
    <PixelStartupGate onEnter={completeStartup} onDockStart={beginStartupDocking} />
  ) : null;

  if (error) {
    return (
      <>
        <div className="app-shell empty-shell">
          <WindowDragRegion />
          <EmptyState title="Dashboard failed to load" body={error} />
        </div>
        {startupGate}
      </>
    );
  }

  if (!snapshot) {
    return (
      <>
        <div className="app-shell empty-shell">
          <WindowDragRegion />
          <EmptyState title="Loading wechat2all" body="Preparing the local dashboard." />
        </div>
        {startupGate}
      </>
    );
  }

  async function onUnlinkWechat() {
    setQrError(null);
    try {
      await unlinkWechatSession(snapshot.profile.id);
      setQr(null);
      setQrImage(null);
      setLoginStatus(null);
      autoQrProfileRef.current = null;
      setSnapshot(await getDashboardSnapshot());
      setActivePage("home");
      setStartupDismissed(false);
      setStartupOverlayVisible(true);
    } catch (err) {
      setQrError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <div
        className={["app-shell", startupDismissed ? "is-startup-dismissed" : ""]
          .filter(Boolean)
          .join(" ")}
        onPointerMove={handleShellPointerMove}
        onPointerLeave={handleShellPointerLeave}
      >
        <WindowDragRegion />
        <CoreConsole active={activePage} onChange={setActivePage} />
        <section className="content-shell field-content">
          {activePage === "home" ? (
            <HomePage
              data={snapshot}
              qr={qr}
              qrImage={qrImage}
              qrError={qrError}
              onOpenRoutes={() => setActivePage("routes")}
            />
          ) : null}
          {activePage === "config" ? (
            <ConfigPage
              data={snapshot}
              qr={qr}
              loginStatus={loginStatus}
              qrImage={qrImage}
              qrError={qrError}
              onRequestQr={() => void requestQr()}
              onUnlink={() => void onUnlinkWechat()}
            />
          ) : null}
          {activePage === "routes" ? (
            <RoutesPage
              routes={snapshot.routes}
              selectedRouteId={selectedRouteId}
              onSelect={setSelectedRouteId}
            />
          ) : null}
        </section>
        {activePage === "agents" ? <AgentsPage /> : null}
        {activePage === "trace" ? <TracePage /> : null}
      </div>
      {startupGate}
      <PixelClickBurstLayer />
    </>
  );
}
