import { useCallback, useEffect, useState } from "react";
import zoomSdk from "@zoom/appssdk";

type ZoomStatus = "checking" | "ready" | "browser" | "error";

type ZoomMeetingContext = {
  meetingID?: string;
  meetingTopic?: string;
  meetingUUID?: string;
  parentUUID?: string;
};

type ZoomUserContext = {
  participantUUID?: string;
  role?: string;
  screenName?: string;
  status?: string;
};

export type ZoomAppContext = {
  clientVersion?: string;
  error?: string;
  isInMeeting: boolean;
  runningContext?: string;
  rtmsStatus?: string;
  startRtms: () => Promise<void>;
  status: ZoomStatus;
  user?: ZoomUserContext;
  meeting?: ZoomMeetingContext;
};

const zoomCapabilities = [
  "getRunningContext",
  "getMeetingContext",
  "getMeetingUUID",
  "getUserContext",
  "shareApp",
  "showNotification",
  "startRTMS",
  "getRTMSStatus",
  "onRTMSStatusChange",
  "onRunningContextChange",
  "onMyUserContextChange"
] as const;

const inMeetingContexts = new Set(["inMeeting", "inWebinar", "inMeetingChat", "inImmersive"]);

function latestRtmsStatus(status?: { status: string }[]) {
  return status?.[status.length - 1]?.status;
}

function sanitizeRoomSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 96);
}

export function roomNameFromZoomContext(zoom: ZoomAppContext) {
  const uuid = zoom.meeting?.parentUUID || zoom.meeting?.meetingUUID;
  if (uuid) return `zoom-${sanitizeRoomSegment(uuid)}`;

  const meetingID = zoom.meeting?.meetingID;
  if (meetingID) return `zoom-${sanitizeRoomSegment(meetingID)}`;

  return undefined;
}

export function identityFromZoomContext(zoom: ZoomAppContext) {
  if (zoom.user?.participantUUID) return `founder-${sanitizeRoomSegment(zoom.user.participantUUID)}`;
  if (zoom.user?.screenName) return `founder-${sanitizeRoomSegment(zoom.user.screenName)}`;
  return undefined;
}

export function useZoomAppContext(): ZoomAppContext {
  const [context, setContext] = useState<ZoomAppContext>({
    isInMeeting: false,
    startRtms: async () => undefined,
    status: "checking"
  });

  const startRtms = useCallback(async () => {
    await zoomSdk.startRTMS();
    const status = await zoomSdk.getRTMSStatus().catch(() => undefined);
    setContext((current) => ({
      ...current,
      rtmsStatus: latestRtmsStatus(status?.rtmsStatus) ?? current.rtmsStatus
    }));
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function configureZoomApp() {
      try {
        const config = await zoomSdk.config({
          capabilities: [...zoomCapabilities],
          popoutSize: { width: 480, height: 760 }
        });
        const runningContext = config.runningContext;
        const isInMeeting = inMeetingContexts.has(runningContext);

        const [meeting, meetingUuid, user] = await Promise.all([
          isInMeeting ? zoomSdk.getMeetingContext().catch(() => undefined) : undefined,
          isInMeeting ? zoomSdk.getMeetingUUID().catch(() => undefined) : undefined,
          isInMeeting ? zoomSdk.getUserContext().catch(() => undefined) : undefined
        ]);
        const rtms = isInMeeting ? await zoomSdk.getRTMSStatus().catch(() => undefined) : undefined;

        if (isInMeeting) {
          zoomSdk.onRTMSStatusChange((event) => {
            setContext((current) => ({
              ...current,
              rtmsStatus: event.status
            }));
          });
        }

        if (!isMounted) return;
        setContext({
          clientVersion: config.clientVersion,
          isInMeeting,
          meeting: {
            ...meeting,
            ...meetingUuid
          },
          runningContext,
          rtmsStatus: latestRtmsStatus(rtms?.rtmsStatus),
          startRtms,
          status: "ready",
          user
        });
      } catch (error) {
        if (!isMounted) return;
        const message = error instanceof Error ? error.message : String(error);
        setContext({
          error: message,
          isInMeeting: false,
          startRtms,
          status: "browser"
        });
      }
    }

    configureZoomApp();

    return () => {
      isMounted = false;
    };
  }, [startRtms]);

  return context;
}
