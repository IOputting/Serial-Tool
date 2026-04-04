import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSerialStore, getTimestamp, LogEntry } from "./stores/useSerialStore";
import SerialSettings from "./components/SerialSettings";
import BasicView from "./views/BasicView";
import GNSSviewer from "./views/GNSSviewer";
import "./App.css";

function App() {
  const { activeView, setIsConnected, addLog, addLogsBatch } = useSerialStore();
  const decoderRef = useRef(new TextDecoder("utf-8"));

  const asciiBufferRef = useRef("");
  const logBuffer = useRef<LogEntry[]>([]);
  const lastFlushTime = useRef(Date.now());

  useEffect(() => {
    // 缓冲池：每 100ms 将数据推入 Zustand
    const flushInterval = setInterval(() => {
      let entriesToPush: LogEntry[] = [];

      if (logBuffer.current.length > 0) {
        entriesToPush = [...logBuffer.current];
        logBuffer.current = [];
      }

      if (asciiBufferRef.current.length > 0) {
        const lastNewlineIdx = asciiBufferRef.current.lastIndexOf('\n');
        const now = Date.now();
        
        if (lastNewlineIdx !== -1) {
          const completeBlock = asciiBufferRef.current.slice(0, lastNewlineIdx + 1);
          asciiBufferRef.current = asciiBufferRef.current.slice(lastNewlineIdx + 1);
          
          entriesToPush.push({
            id: crypto.randomUUID(), type: 'recv', text: completeBlock,
            time: getTimestamp(), timestampMs: now, isHex: false
          });
        } else if (now - lastFlushTime.current > 200) {
          entriesToPush.push({
            id: crypto.randomUUID(), type: 'recv', text: asciiBufferRef.current,
            time: getTimestamp(), timestampMs: now, isHex: false
          });
          asciiBufferRef.current = "";
        }
      }

      if (entriesToPush.length > 0) {
        addLogsBatch(entriesToPush);
        lastFlushTime.current = Date.now();
      }
    }, 100);

    const unlistenData = listen<number[]>("serial-data", (event) => {
      const bytes = new Uint8Array(event.payload);
      const isHex = useSerialStore.getState().isHexRecv;

      if (isHex) {
        const hexText = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') + ' ';
        logBuffer.current.push({ id: crypto.randomUUID(), type: 'recv', text: hexText, time: getTimestamp(), timestampMs: Date.now(), isHex: true });
      } else {
        const decodedText = decoderRef.current.decode(bytes, { stream: true });
        asciiBufferRef.current += decodedText;
      }
    });

    const unlistenDisconnect = listen<string>("serial-disconnected", async (event) => {
      setIsConnected(false); 
      addLog({ id: crypto.randomUUID(), type: 'sys', text: `设备断开 (${event.payload}) 🔴\n`, time: getTimestamp(), timestampMs: Date.now(), isHex: false });
      try { await invoke("disconnect_port"); } catch (e) {}
    });

    const unlistenSys = listen<string>("sys-log", (event) => { 
      addLog({ id: crypto.randomUUID(), type: 'sys', text: event.payload + '\n', time: getTimestamp(), timestampMs: Date.now(), isHex: false });
    });

    return () => { 
      clearInterval(flushInterval);
      unlistenData.then(f => f()); 
      unlistenDisconnect.then(f => f()); 
      unlistenSys.then(f => f()); 
    };
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw", backgroundColor: "#f0f2f5", overflow: "hidden" }}>
      <SerialSettings />
      <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column" }}>
        {activeView === 'basic' && <BasicView />}
        {activeView === 'oscilloscope' && (
          <div style={{ padding: "40px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#666" }}>
            <h1 style={{fontSize: "36px", marginBottom: "10px"}}>📈 高级示波器开发中...</h1>
          </div>
        )}
        {activeView === 'script' && (
          <div style={{ padding: "40px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#666" }}>
            <h1 style={{fontSize: "36px", marginBottom: "10px"}}>💻 编程发送开发中...</h1>
          </div>
        )}
        {activeView === 'GNSSviewer' && <GNSSviewer />}
      </div>
    </div>
  );
}

export default App;
