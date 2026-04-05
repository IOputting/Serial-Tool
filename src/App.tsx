import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSerialStore, getTimestamp } from "./stores/useSerialStore";
import SerialSettings from "./components/SerialSettings";
import BasicView from "./views/BasicView";
import GNSSviewer from "./views/GNSSviewer";
import "./App.css";

function App() {
  // 移除了 addLogsBatch，因为不再需要批量推送
  const { activeView, setIsConnected, addLog } = useSerialStore();
  const decoderRef = useRef(new TextDecoder("utf-8"));
  const asciiBufferRef = useRef("");

  useEffect(() => {
    const unlistenData = listen<number[]>("serial-data", (event) => {
      const bytes = new Uint8Array(event.payload);
      const isHex = useSerialStore.getState().isHexRecv;
      const now = Date.now();

      if (isHex) {
        // Hex 模式：收到数据瞬间直接推送
        const hexText = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') + ' ';
        addLog({ 
          id: crypto.randomUUID(), type: 'recv', text: hexText, 
          time: getTimestamp(), timestampMs: now, isHex: true 
        });
      } else {
        // ASCII 模式：解码并拼接到临时变量
        const decodedText = decoderRef.current.decode(bytes, { stream: true });
        asciiBufferRef.current += decodedText;

        // 只要检测到换行符，立刻截取完整数据块并推送，无时间延迟
        const lastNewlineIdx = asciiBufferRef.current.lastIndexOf('\n');
        if (lastNewlineIdx !== -1) {
          const completeBlock = asciiBufferRef.current.slice(0, lastNewlineIdx + 1);
          asciiBufferRef.current = asciiBufferRef.current.slice(lastNewlineIdx + 1);
          
          addLog({
            id: crypto.randomUUID(), type: 'recv', text: completeBlock,
            time: getTimestamp(), timestampMs: now, isHex: false
          });
        }
      }
    });

    const unlistenDisconnect = listen<string>("serial-disconnected", async (event) => {
      setIsConnected(false); 
      addLog({ 
        id: crypto.randomUUID(), type: 'sys', text: `设备断开 (${event.payload}) 🔴\n`, 
        time: getTimestamp(), timestampMs: Date.now(), isHex: false 
      });
      try { await invoke("disconnect_port"); } catch (e) {}
    });

    const unlistenSys = listen<string>("sys-log", (event) => { 
      addLog({ 
        id: crypto.randomUUID(), type: 'sys', text: event.payload + '\n', 
        time: getTimestamp(), timestampMs: Date.now(), isHex: false 
      });
    });

    return () => { 
      // 清理监听器
      unlistenData.then(f => f()); 
      unlistenDisconnect.then(f => f()); 
      unlistenSys.then(f => f()); 
    };
  }, []); // 依赖项为空，确保只挂载一次

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
