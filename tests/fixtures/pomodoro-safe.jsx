import { useEffect, useState, useRef, useCallback } from "react";
import { db } from "./db";

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
  const [completionMessage, setCompletionMessage] = useState("");

  const intervalRef = useRef(null);
  const modeRef = useRef(mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const recordPomodoro = useCallback(async () => {
    await db.insert("pomodoros", { date: getTodayString() });
    setTodayCount((c) => c + 1);
  }, []);

  const handleTimerComplete = useCallback((currentMode) => {
    if (currentMode === "work") {
      recordPomodoro();
      setCompletionMessage("本轮专注完成，休息一下吧");
      setMode("rest");
      setSecondsLeft(REST_SECONDS);
    } else {
      setCompletionMessage("休息结束，准备下一轮专注");
      setMode("work");
      setSecondsLeft(WORK_SECONDS);
    }
  }, [recordPomodoro]);

  const startTimer = useCallback((nextMode) => {
    clearTimer();
    setCompletionMessage("");
    setIsRunning(true);
    const duration = nextMode === "rest" ? REST_SECONDS : WORK_SECONDS;
    setSecondsLeft(duration);
    intervalRef.current = setInterval(() => {
      // 更新器只做纯计算,归零后的副作用交给下方的 useEffect
      setSecondsLeft((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
  }, [clearTimer]);

  // 归零副作用移到 useEffect:避免在 setState 更新器里重复执行 / 嵌套 setState
  useEffect(() => {
    if (secondsLeft === 0 && isRunning) {
      clearTimer();
      setIsRunning(false);
      handleTimerComplete(modeRef.current);
    }
  }, [secondsLeft, isRunning, clearTimer, handleTimerComplete]);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  const handleStart = () => startTimer(modeRef.current);
  const handlePause = () => {
    clearTimer();
    setIsRunning(false);
  };
  const handleSwitchMode = (nextMode) => {
    clearTimer();
    setCompletionMessage("");
    setIsRunning(false);
    modeRef.current = nextMode;
    setMode(nextMode);
    setSecondsLeft(nextMode === "rest" ? REST_SECONDS : WORK_SECONDS);
  };

  return (
    <div>
      <button onClick={handleStart}>开始番茄</button>
      <button onClick={handlePause}>暂停</button>
      <button onClick={() => handleSwitchMode("rest")}>休息</button>
      <button onClick={() => handleSwitchMode("work")}>工作</button>
      <div>{completionMessage}</div>
      <div>完成 {todayCount} 个</div>
    </div>
  );
}
