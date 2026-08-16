import { useEffect, useState, useRef, useCallback } from "react";
import { db } from "./db";
import Timer from "./components/Timer";
import TodayPanel from "./components/TodayPanel";

const WORK_SECONDS = 25 * 60;
const REST_SECONDS = 5 * 60;

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function App() {
  const [mode, setMode] = useState("work");
  const [secondsLeft, setSecondsLeft] = useState(WORK_SECONDS);
  const [isRunning, setIsRunning] = useState(false);
  const [todayCount, setTodayCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState(false);
  const [completionMessage, setCompletionMessage] = useState("");

  const intervalRef = useRef(null);
  const modeRef = useRef(mode);
  const secondsLeftRef = useRef(secondsLeft);
  const todayCountRef = useRef(todayCount);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    secondsLeftRef.current = secondsLeft;
  }, [secondsLeft]);

  useEffect(() => {
    todayCountRef.current = todayCount;
  }, [todayCount]);

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const loadTodayCount = useCallback(async () => {
    try {
      const records = await db.list("pomodoros");
      const today = getTodayString();
      const count = records.filter((r) => r.date === today).length;
      setTodayCount(count);
    } catch (e) {
      setStorageError(true);
      setTodayCount(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTodayCount();
    return () => clearTimer();
  }, [loadTodayCount, clearTimer]);

  const recordPomodoro = useCallback(async () => {
    try {
      await db.insert("pomodoros", {
        completedAt: new Date().toISOString(),
        date: getTodayString(),
      });
      setTodayCount((c) => c + 1);
    } catch (e) {
      setStorageError(true);
      setTodayCount((c) => c + 1);
    }
  }, []);

  const handleTimerComplete = useCallback(
    (currentMode) => {
      clearTimer();
      setIsRunning(false);
      if (currentMode === "work") {
        recordPomodoro();
        setCompletionMessage("本轮专注完成，休息一下吧");
        setMode("rest");
        modeRef.current = "rest";
        setSecondsLeft(REST_SECONDS);
      } else {
        setCompletionMessage("休息结束，准备下一轮专注");
        setMode("work");
        modeRef.current = "work";
        setSecondsLeft(WORK_SECONDS);
      }
    },
    [clearTimer, recordPomodoro]
  );

  const startTimer = useCallback(
    (nextMode, duration) => {
      clearTimer();
      setCompletionMessage("");
      setIsRunning(true);
      setSecondsLeft(duration);
      intervalRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          const next = prev - 1;
          if (next <= 0) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
            handleTimerComplete(modeRef.current);
            return 0;
          }
          return next;
        });
      }, 1000);
    },
    [clearTimer, handleTimerComplete]
  );

  const handleStart = () => {
    if (secondsLeftRef.current <= 0) {
      startTimer(modeRef.current, modeRef.current === "work" ? WORK_SECONDS : REST_SECONDS);
    } else {
      clearTimer();
      setCompletionMessage("");
      setIsRunning(true);
      intervalRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          const next = prev - 1;
          if (next <= 0) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
            handleTimerComplete(modeRef.current);
            return 0;
          }
          return next;
        });
      }, 1000);
    }
  };

  const handlePause = () => {
    clearTimer();
    setIsRunning(false);
  };

  const handleSwitchMode = (nextMode) => {
    clearTimer();
    setCompletionMessage("");
    setIsRunning(false);
    setMode(nextMode);
    modeRef.current = nextMode;
    const duration = nextMode === "work" ? WORK_SECONDS : REST_SECONDS;
    setSecondsLeft(duration);
  };

  return (
    <div className="min-h-screen bg-[#F5F2EA] text-[#221D19]">
      <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_280px] lg:gap-12">
          <main className="flex flex-col items-center justify-center min-h-[70vh]">
            <Timer
              mode={mode}
              secondsLeft={secondsLeft}
              isRunning={isRunning}
              loading={loading}
              completionMessage={completionMessage}
              onStart={handleStart}
              onPause={handlePause}
              onSwitchMode={handleSwitchMode}
            />
          </main>
          <aside className="lg:border-l lg:border-[#E4DFD3] lg:pl-10">
            <TodayPanel count={todayCount} loading={loading} storageError={storageError} />
          </aside>
        </div>
      </div>
    </div>
  );
}
