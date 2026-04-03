import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

type LogType = 'send' | 'recv' | 'sys';
interface LogEntry { id: string; type: LogType; text: string; time: string; isHex: boolean; }
interface PortInfo { name: string; desc: string; }
interface QuickCommand { id: string; name: string; data: string; isHex: boolean; }
type SendMode = 'ascii' | 'hex' | 'timed' | 'file';

const getTimestamp = () => {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};

const COMMON_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [baudRate, setBaudRate] = useState("115200");
  const [isCustomBaud, setIsCustomBaud] = useState(false);
  const [dataBits, setDataBits] = useState("8");
  const [parity, setParity] = useState("None");
  const [stopBits, setStopBits] = useState("1");
  const [dtr, setDtr] = useState(false);
  const [rts, setRts] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sendText, setSendText] = useState("");
  const [appendCrlf, setAppendCrlf] = useState(true);
  const [clearAfterSend, setClearAfterSend] = useState(true); 
  const [showInvisible, setShowInvisible] = useState(false); 
  
  // 接收模式状态
  const [isHexRecv, setIsHexRecv] = useState(false);
  
  // 发送模式状态
  const [sendMode, setSendMode] = useState<SendMode>('ascii');
  const [timerInterval, setTimerInterval] = useState(1000);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [timedIsHex, setTimedIsHex] = useState(false); 
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const timerRef = useRef<number | null>(null);

  const isHexRecvRef = useRef(false);
  const decoderRef = useRef(new TextDecoder("utf-8"));
  const logEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [suggestions, setSuggestions] = useState<QuickCommand[]>([]);
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const suggestionsListRef = useRef<HTMLDivElement>(null);

  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [showCmdModal, setShowCmdModal] = useState(false);
  const [newCmdName, setNewCmdName] = useState("");
  const [newCmdData, setNewCmdData] = useState("");
  const [newCmdIsHex, setNewCmdIsHex] = useState(false);
  const [quickCmdSearch, setQuickCmdSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem('serial-quick-commands');
    if (saved) { try { setQuickCommands(JSON.parse(saved)); } catch (e) {} } 
    else {
      setQuickCommands([
        { id: crypto.randomUUID(), name: "测试 AT", data: "AT", isHex: false },
        { id: crypto.randomUUID(), name: "查询版本", data: "AT+GMR", isHex: false }
      ]);
    }
  }, []);

  useEffect(() => { localStorage.setItem('serial-quick-commands', JSON.stringify(quickCommands)); }, [quickCommands]);

  useEffect(() => {
    isHexRecvRef.current = isHexRecv;
    if (!isHexRecv) decoderRef.current = new TextDecoder("utf-8");
  }, [isHexRecv]);

  const fetchPorts = async () => {
    const res = await invoke<PortInfo[]>("get_available_ports");
    setPorts(res);
    if (res.length > 0 && (!selectedPort || !res.find(p => p.name === selectedPort))) {
      setSelectedPort(res[0].name);
    } else if (res.length === 0) {
      setSelectedPort("");
    }
  };

  useEffect(() => {
    fetchPorts();
    const unlistenData = listen<number[]>("serial-data", (event) => {
      const bytes = new Uint8Array(event.payload);
      let newText = "";
      const isHex = isHexRecvRef.current;
      if (isHex) newText = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') + ' ';
      else newText = decoderRef.current.decode(bytes, { stream: true });
      if (!newText) return;

      setLogs(prev => {
        const lastLog = prev[prev.length - 1];
        if (lastLog && lastLog.type === 'recv' && lastLog.isHex === isHex) {
          const updated = [...prev]; updated[updated.length - 1] = { ...lastLog, text: lastLog.text + newText }; return updated;
        } else { return [...prev, { id: crypto.randomUUID(), type: 'recv', text: newText, time: getTimestamp(), isHex }]; }
      });
    });

    const unlistenDisconnect = listen<string>("serial-disconnected", async (event) => {
      setIsConnected(false); addSysLog(`设备断开 (${event.payload}) 🔴`);
      try { await invoke("disconnect_port"); } catch (e) {}
    });

    const unlistenSys = listen<string>("sys-log", (event) => { addSysLog(event.payload); });

    return () => { unlistenData.then(f => f()); unlistenDisconnect.then(f => f()); unlistenSys.then(f => f()); };
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  useEffect(() => {
    if ((!isConnected || sendMode !== 'timed') && isTimerRunning) stopTimer();
  }, [isConnected, sendMode]);

  const addSysLog = (msg: string) => setLogs(prev => [...prev, { id: crypto.randomUUID(), type: 'sys', text: msg + '\n', time: getTimestamp(), isHex: false }]);

  const toggleConnection = async () => {
    if (isConnected) {
      await invoke("disconnect_port"); setIsConnected(false); addSysLog("串口已手动断开 🔴");
    } else {
      if (!selectedPort) return alert("请先选择设备！");
      try {
        await invoke("connect_port", { portName: selectedPort, baudRate: Number(baudRate), dataBits: Number(dataBits), parity, stopBits: Number(stopBits), dtr, rts });
        setIsConnected(true); addSysLog(`已连接 ${selectedPort} (${baudRate}, ${dataBits}, ${parity}, ${stopBits}) 🟢`);
        setTimeout(() => { textareaRef.current?.focus(); }, 100);
      } catch (e) { alert("连接失败: " + e); }
    }
  };

  const handleDtrChange = async (val: boolean) => { setDtr(val); if (isConnected) await invoke("set_dtr_rts", { dtr: val, rts }); };
  const handleRtsChange = async (val: boolean) => { setRts(val); if (isConnected) await invoke("set_dtr_rts", { dtr, rts: val }); };

  const executeSend = async (data: string, isHex: boolean, useCrlf: boolean) => {
    if (!isConnected) { alert("请先连接串口！"); return false; }
    if (!data) return false;
    let dataToSend = data;
    if (!isHex && useCrlf) dataToSend += "\r\n"; 
    try {
      await invoke("send_data", { data: dataToSend, isHex: isHex });
      setLogs(prev => [...prev, { id: crypto.randomUUID(), type: 'send', text: dataToSend + (isHex ? '\n' : ''), time: getTimestamp(), isHex: isHex }]);
      return true;
    } catch (e) { alert("发送报错: " + e); return false; }
  };

  const handleMainSendAction = async () => {
    if (sendMode === 'file') {
      if (!isConnected) return alert("请先连接串口！");
      if (!selectedFilePath) return alert("请先选择要发送的文件！");
      try { await invoke("send_file", { filePath: selectedFilePath }); } catch (e) { alert("启动文件发送失败: " + e); }
    } else if (sendMode === 'timed') {
      if (isTimerRunning) stopTimer(); else startTimer();
    } else {
      const isHex = sendMode === 'hex';
      const success = await executeSend(sendText, isHex, appendCrlf && !isHex);
      if (success) {
        if (clearAfterSend) { setSendText(""); setSuggestions([]); }
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    }
  };

  const startTimer = () => {
    if (!isConnected) return alert("请先连接串口！");
    if (!sendText) return alert("请输入要发送的数据！");
    if (timerInterval < 10) return alert("定时时间不能小于 10ms");
    setIsTimerRunning(true); executeSend(sendText, timedIsHex, appendCrlf && !timedIsHex); 
    timerRef.current = window.setInterval(() => { executeSend(sendText, timedIsHex, appendCrlf && !timedIsHex); }, timerInterval);
  };

  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } setIsTimerRunning(false); };

  const handleSelectFile = async () => {
    const selected = await open({ multiple: false, directory: false });
    if (selected) setSelectedFilePath(selected as string);
  };

  const handleSaveLogs = async () => {
    if (logs.length === 0) return alert("当前没有可保存的日志！");
    try {
      const textContent = logs.map(log => {
        let prefix = "";
        if (log.type === 'send') prefix = "发送 -> ";
        else if (log.type === 'recv') prefix = "接收 <- ";
        else if (log.type === 'sys') prefix = "系统 -- ";
        const text = renderHighlightedText(log.text, log.isHex);
        return `[${log.time}] ${prefix}${text}`;
      }).join('\n');

      const filePath = await save({
        filters: [{ name: 'Log/Text File', extensions: ['txt', 'log'] }],
        defaultPath: 'serial_log.txt'
      });

      if (filePath) {
        await writeTextFile(filePath, textContent);
        alert("日志保存成功！📂");
      }
    } catch (err: any) {
      alert("保存失败：" + (typeof err === 'string' ? err : err?.message));
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value; setSendText(val);
    const cursor = e.target.selectionStart;
    const currentWord = val.substring(0, cursor).split(/\s+/).pop() || "";
    if (currentWord.length > 0) {
      setSuggestions(quickCommands.filter(c => c.data.toLowerCase().startsWith(currentWord.toLowerCase()))); setSuggestionIdx(0);
    } else { setSuggestions([]); }
  };

  const applySuggestion = (selected: QuickCommand) => {
    if (!textareaRef.current) return;
    const target = textareaRef.current; const cursor = target.selectionStart;
    const textBeforeCursor = sendText.substring(0, cursor);
    const currentWord = textBeforeCursor.split(/\s+/).pop() || "";
    const newTextBefore = textBeforeCursor.substring(0, textBeforeCursor.length - currentWord.length) + selected.data;
    const newText = newTextBefore + sendText.substring(cursor);
    setSendText(newText); setSuggestions([]);
    setTimeout(() => { target.focus(); target.selectionStart = target.selectionEnd = newTextBefore.length; }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey)) { e.preventDefault(); applySuggestion(suggestions[suggestionIdx]); return; } 
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestionIdx(prev => (prev > 0 ? prev - 1 : suggestions.length - 1)); return; } 
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestionIdx(prev => (prev < suggestions.length - 1 ? prev + 1 : 0)); return; } 
      else if (e.key === 'Escape') { setSuggestions([]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); handleMainSendAction(); }
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); setSendText(prev => prev + '\n'); }
  };

  const addQuickCommand = () => {
    if (!newCmdName || !newCmdData) return alert("名称和内容不能为空！");
    setQuickCommands([...quickCommands, { id: crypto.randomUUID(), name: newCmdName, data: newCmdData, isHex: newCmdIsHex }]);
    setNewCmdName(""); setNewCmdData("");
  };

  const exportCommands = async () => {
    try {
      const dataStr = JSON.stringify(quickCommands, null, 2);
      const filePath = await save({ filters: [{ name: 'JSON', extensions: ['json'] }], defaultPath: 'serial_commands.json' });
      if (filePath) { await writeTextFile(filePath, dataStr); alert("导出成功！"); }
    } catch (err: any) { alert("导出失败：" + (typeof err === 'string' ? err : err?.message)); }
  };

  const importCommands = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try { const imported = JSON.parse(event.target?.result as string);
        if (Array.isArray(imported)) { setQuickCommands(imported); alert("导入成功！"); } else alert("格式错误！");
      } catch (err) { alert("解析失败！"); }
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.readAsText(file);
  };

  const renderHighlightedText = (text: string, isHex: boolean) => {
    if (!isHex && showInvisible) return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n\n').replace(/\0/g, '\\0');
    return text;
  };

  return (
    <div style={{ display: "flex", position: "absolute", inset: 0, backgroundColor: "#f0f2f5", fontFamily: "sans-serif", overflow: "hidden" }}>
      
      {/* ===== 左侧分栏 ===== */}
      <div style={{ width: "220px", minWidth: "220px", display: "flex", flexDirection: "column", backgroundColor: "#fff", borderRight: "1px solid #ddd", zIndex: 10, boxShadow: "2px 0 8px rgba(0,0,0,0.05)" }}>
        {/* 串口配置面板 */}
        <div style={{ padding: "15px", borderBottom: "1px solid #eee" }}>
          <h2 style={{ margin: "0 0 15px 0", fontSize: "18px", color: "#333", display: "flex", alignItems: "center", gap: "8px" }}>🔧 串口设置</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>端口</span>
              <select value={selectedPort} onChange={(e) => setSelectedPort(e.target.value)} onMouseEnter={fetchPorts} onFocus={fetchPorts} disabled={isConnected} style={{ width: "120px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc", cursor: "pointer" }}>
                {ports.length === 0 && <option value="">无设备</option>}
                {ports.map((p) => <option key={p.name} value={p.name} title={p.desc}>{p.desc}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>波特率</span>
              <div onDoubleClick={() => !isConnected && setIsCustomBaud(true)} title="双击可手动输入" style={{ width: "120px" }}>
                {isCustomBaud ? (
                  <input type="number" value={baudRate} onChange={(e) => setBaudRate(e.target.value)} onBlur={() => setIsCustomBaud(false)} autoFocus disabled={isConnected} style={{ width: "100%", padding: "4px", borderRadius: "4px", border: "1px solid #1890ff", boxSizing: "border-box", outline: "none" }} />
                ) : (
                  <select value={baudRate} onChange={(e) => setBaudRate(e.target.value)} disabled={isConnected} style={{ width: "100%", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}>
                    {!COMMON_BAUD_RATES.includes(Number(baudRate)) && <option value={baudRate}>{baudRate}</option>}
                    {COMMON_BAUD_RATES.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                )}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>数据位</span>
              <select value={dataBits} onChange={(e) => setDataBits(e.target.value)} disabled={isConnected} style={{ width: "120px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}><option value="8">8</option><option value="7">7</option><option value="6">6</option><option value="5">5</option></select>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>校验位</span>
              <select value={parity} onChange={(e) => setParity(e.target.value)} disabled={isConnected} style={{ width: "120px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}><option value="None">None</option><option value="Odd">Odd</option><option value="Even">Even</option></select>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>停止位</span>
              <select value={stopBits} onChange={(e) => setStopBits(e.target.value)} disabled={isConnected} style={{ width: "120px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}><option value="1">1</option><option value="2">2</option></select>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "5px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer" }}><input type="checkbox" checked={dtr} onChange={(e) => handleDtrChange(e.target.checked)} /> DTR</label>
              <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer" }}><input type="checkbox" checked={rts} onChange={(e) => handleRtsChange(e.target.checked)} /> RTS</label>
            </div>
            <button onClick={toggleConnection} style={{ marginTop: "5px", cursor: "pointer", backgroundColor: isConnected ? "#ff4d4f" : "#1890ff", color: "white", border: "none", padding: "10px", borderRadius: "4px", fontWeight: "bold", fontSize: "14px", width: "100%", transition: "background-color 0.2s" }}>
              {isConnected ? "断开连接" : "打开串口"}
            </button>
          </div>
        </div>

        {/* 快捷执行面板 */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", backgroundColor: "#fafafa" }}>
          <div style={{ padding: "12px 15px", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: "bold", color: "#333", fontSize: "14px" }}>🚀 快捷指令</span>
            <button onClick={() => setShowCmdModal(true)} style={{ cursor: "pointer", background: "none", border: "1px solid #d9d9d9", borderRadius: "4px", padding: "4px 8px", fontSize: "12px", backgroundColor: "#fff" }}>⚙️ 设置</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {quickCommands.length === 0 && <div style={{textAlign: "center", color: "#aaa", fontSize: "12px", marginTop: "20px"}}>暂无快捷指令</div>}
            {quickCommands.map((cmd) => (
              <button key={cmd.id} onClick={() => executeSend(cmd.data, cmd.isHex, appendCrlf)} disabled={!isConnected} title={cmd.data} style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "8px 10px", borderRadius: "6px", border: "1px solid #ddd", background: "#fff", cursor: isConnected ? "pointer" : "not-allowed", opacity: isConnected ? 1 : 0.6, textAlign: "left" }}>
                <div style={{ fontWeight: "bold", fontSize: "13px", color: "#333" }}>{cmd.name} {cmd.isHex && <span style={{ color: "#e91e63", fontSize: "10px", marginLeft: "4px", border: "1px solid #f8bbd0", padding: "0 2px", borderRadius: "2px" }}>HEX</span>}</div>
                <div style={{ fontSize: "11px", color: "#888", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", width: "100%" }}>{cmd.data}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ===== 右侧分栏 ===== */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "20px", gap: "15px", position: "relative" }}>
        
        {/* 日志控制工具栏 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#fff", padding: "8px 15px", borderRadius: "8px", border: "1px solid #e8e8e8", boxShadow: "0 1px 4px rgba(0,0,0,0.02)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", backgroundColor: isConnected ? "#52c41a" : "#f5222d", boxShadow: isConnected ? "0 0 6px #52c41a" : "none" }}></span>
            <span style={{ fontSize: "15px", fontWeight: "bold", color: "#333" }}>
              {isConnected ? "已连接" : "未连接"}
            </span>
          </div>
          
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "13px", color: "#666" }}>解析:</span>
                <select value={isHexRecv ? "hex" : "ascii"} onChange={(e) => setIsHexRecv(e.target.value === "hex")} style={{ padding: "4px 6px", borderRadius: "4px", border: "1px solid #d9d9d9", outline: "none", cursor: "pointer", fontSize: "13px", color: "#333", backgroundColor: "#fafafa" }}>
                  <option value="ascii">📝 ASCII</option>
                  <option value="hex">📦 HEX</option>
                </select>
              </div>

              <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", color: isHexRecv ? "#bbb" : "#555", fontSize: "13px" }}>
                <input type="checkbox" checked={showInvisible} onChange={(e) => setShowInvisible(e.target.checked)} disabled={isHexRecv} />
                显示不可见字符
              </label>
            </div>

            <div style={{ width: "1px", height: "18px", backgroundColor: "#e0e0e0" }}></div>
            
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <button onClick={handleSaveLogs} title="导出当前显示的所有日志到本地文件" style={{ cursor: "pointer", padding: "4px 12px", borderRadius: "4px", border: "1px solid #b7eb8f", backgroundColor: "#f6ffed", color: "#389e0d", fontSize: "13px", display: "flex", alignItems: "center", gap: "4px", transition: "all 0.2s" }}>
                <span>💾</span> 保存日志
              </button>
              <button onClick={() => setLogs([])} style={{ cursor: "pointer", padding: "4px 12px", borderRadius: "4px", border: "1px solid #d9d9d9", backgroundColor: "#fff", color: "#555", fontSize: "13px", display: "flex", alignItems: "center", gap: "4px", transition: "all 0.2s" }}>
                <span>🗑️</span> 清空
              </button>
            </div>
          </div>
        </div>

        {/* 日志输出框 */}
        <div style={{ flex: 1, backgroundColor: "#1e1e1e", padding: "15px", borderRadius: "8px", overflowY: "auto", whiteSpace: "pre-wrap", fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: "14px", boxShadow: "inset 0 2px 10px rgba(0,0,0,0.2)" }}>
          {logs.length === 0 ? <span style={{ color: "#666" }}>等待数据传输...</span> : null}
          {logs.map((log) => {
            let color = "#fff"; let prefix = "";
            if (log.type === 'send') { color = "#40a9ff"; prefix = "-> \n"; } 
            else if (log.type === 'recv') { color = "#73d13d"; prefix = "<- \n"; } 
            else if (log.type === 'sys') { color = "#ffc53d"; prefix = "SYS "; } 
            return (
              <div key={log.id} style={{ color: color, wordBreak: "break-all", marginBottom: "6px", lineHeight: "1.5" }}>
                <span style={{ color: "#777", marginRight: "8px", userSelect: "none", fontSize: "12px" }}>[{log.time}]</span>
                <span style={{ opacity: 0.6, userSelect: "none", marginRight: "5px" }}>{prefix}</span>
                <span>{renderHighlightedText(log.text, log.isHex)}</span>
              </div>
            );
          })}
          <div ref={logEndRef} />
        </div>

        {/* 发送控制区 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", backgroundColor: "#fff", padding: "10px 15px", borderRadius: "8px", boxShadow: "0 -2px 10px rgba(0,0,0,0.02)", position: "relative" }}>
          
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "6px", borderBottom: "1px solid #eee" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "15px" }}>
              <span style={{ fontWeight: "bold", fontSize: "14px", color: "#333" }}>发送模式：</span>
              <select value={sendMode} onChange={(e) => setSendMode(e.target.value as SendMode)} style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid #ccc", outline: "none", cursor: "pointer", fontSize: "13px" }}>
                <option value="ascii">📝 手动 (ASCII)</option>
                <option value="hex">📦 手动 (HEX)</option>
                <option value="timed">⏱️ 定时发送</option>
                <option value="file">📁 文件发送</option>
              </select>

              <div style={{ display: "flex", gap: "15px", marginLeft: "10px", borderLeft: "1px solid #ddd", paddingLeft: "15px" }}>
                {sendMode === 'ascii' && <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", color: "#555" }}><input type="checkbox" checked={appendCrlf} onChange={(e) => setAppendCrlf(e.target.checked)} />加回车换行</label>}
                {sendMode === 'timed' && (
                  <>
                    <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", color: timedIsHex ? "#e91e63" : "#555" }}><input type="checkbox" checked={timedIsHex} onChange={(e) => setTimedIsHex(e.target.checked)} disabled={isTimerRunning} />以 HEX 发送</label>
                    {(!timedIsHex) && <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", color: "#555" }}><input type="checkbox" checked={appendCrlf} onChange={(e) => setAppendCrlf(e.target.checked)} disabled={isTimerRunning} />加回车换行</label>}
                    <span style={{ fontSize: "13px", color: "#555", display: "flex", alignItems: "center", gap: "5px" }}>间隔: <input type="number" value={timerInterval} onChange={(e) => setTimerInterval(Number(e.target.value))} disabled={isTimerRunning} style={{ width: "60px", padding: "2px", border: "1px solid #ccc", borderRadius: "3px" }} /> ms</span>
                  </>
                )}
                {(sendMode === 'ascii' || sendMode === 'hex') && <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", color: "#555" }}><input type="checkbox" checked={clearAfterSend} onChange={(e) => setClearAfterSend(e.target.checked)} />发送后清空</label>}
              </div>
            </div>
          </div>

          {suggestions.length > 0 && sendMode !== 'file' && (
            <div style={{ position: 'absolute', bottom: '100%', left: '15px', marginBottom: '8px', backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', zIndex: 100, minWidth: '300px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div ref={suggestionsListRef} style={{ maxHeight: '175px', overflowY: 'auto' }}>
                {suggestions.map((s, idx) => (
                  <div key={s.id} onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }} onMouseEnter={() => setSuggestionIdx(idx)} style={{ padding: '8px 12px', backgroundColor: idx === suggestionIdx ? '#e6f7ff' : '#fff', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: '13px', color: '#333' }}>
                    <span style={{ fontWeight: 'bold', color: '#0050b3' }}>{s.data}</span><span style={{ color: '#888', marginLeft: '10px' }}>({s.name})</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: '4px 12px', fontSize: '11px', color: '#bbb', backgroundColor: '#fafafa', textAlign: 'right', borderTop: '1px solid #eee' }}>按 Tab/Enter 补全，↑/↓/滚轮 切换</div>
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", alignItems: "stretch" }}>
            {sendMode === 'file' ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "10px", backgroundColor: "#fafafa", padding: "8px 15px", borderRadius: "6px", border: "1px dashed #d9d9d9", minHeight: "60px", boxSizing: "border-box" }}>
                <div style={{ fontSize: "20px", opacity: 0.5 }}>📄</div>
                <input type="text" value={selectedFilePath} readOnly placeholder="请点击右侧按钮选择文件..." style={{ flex: 1, padding: "8px 12px", borderRadius: "4px", border: "1px solid #ccc", outline: "none", backgroundColor: "#fff", fontSize: "14px" }} />
                <button onClick={handleSelectFile} style={{ padding: "8px 15px", cursor: "pointer", border: "1px solid #1890ff", backgroundColor: "#e6f7ff", color: "#1890ff", borderRadius: "4px", fontWeight: "bold", fontSize: "14px" }}>浏览文件</button>
              </div>
            ) : (
              <textarea 
                ref={textareaRef} 
                value={sendText} 
                onChange={handleTextareaChange} 
                onKeyDown={handleKeyDown}
                onBlur={() => setTimeout(() => setSuggestions([]), 150)}
                disabled={!isConnected || (sendMode === 'timed' && isTimerRunning)}
                placeholder={sendMode === 'hex' ? "在此输入 HEX 数据 (如: FF 0A)..." : "在此输入发送内容 (换行: Ctrl+Enter)..."} 
                style={{ flex: 1, minHeight: "60px", height: "60px", padding: "8px 12px", borderRadius: "6px", border: "1px solid #d9d9d9", outline: "none", resize: "none", fontFamily: "inherit", fontSize: "14px", lineHeight: "1.5", cursor: (isConnected && !isTimerRunning) ? "text" : "not-allowed", backgroundColor: (isConnected && !isTimerRunning) ? "#fff" : "#f5f5f5", boxSizing: "border-box", overflowY: "auto" }}
              />
            )}

            <button onClick={handleMainSendAction} disabled={!isConnected} style={{ width: "120px", cursor: isConnected ? "pointer" : "not-allowed", backgroundColor: !isConnected ? "#d9d9d9" : (sendMode === 'timed' && isTimerRunning) ? "#ff4d4f" : "#1890ff", color: "white", border: "none", borderRadius: "6px", fontWeight: "bold", fontSize: "15px", display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: "6px", transition: "all 0.2s" }}>
              <span>{sendMode === 'timed' ? (isTimerRunning ? '停止定时' : '开始定时') : sendMode === 'file' ? '发送文件' : '发送'}</span>
              {sendMode !== 'timed' && sendMode !== 'file' && <span style={{ fontSize: "12px", fontWeight: "normal", opacity: 0.8 }}>(Enter)</span>}
            </button>
          </div>
        </div>
      </div>

      {/* 快捷指令设置窗口 */}
      {showCmdModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 9999, display: "flex", justifyContent: "center", alignItems: "center", backdropFilter: "blur(2px)" }}>
          <div style={{ width: "600px", height: "550px", backgroundColor: "#fff", borderRadius: "10px", display: "flex", flexDirection: "column", boxShadow: "0 10px 30px rgba(0,0,0,0.2)", overflow: "hidden" }}>
            <div style={{ padding: "15px 20px", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#f9f9f9" }}>
              <h3 style={{ margin: 0, color: "#333", fontSize: "16px" }}>⚙️ 快捷指令管理</h3>
              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <button onClick={exportCommands} style={{ cursor: "pointer", background: "none", border: "1px solid #ccc", borderRadius: "4px", padding: "4px 10px", fontSize: "12px", backgroundColor: "#fff" }}>导出 JSON</button>
                <button onClick={() => fileInputRef.current?.click()} style={{ cursor: "pointer", background: "none", border: "1px solid #ccc", borderRadius: "4px", padding: "4px 10px", fontSize: "12px", backgroundColor: "#fff" }}>导入 JSON</button>
                <input type="file" accept=".json" style={{ display: "none" }} ref={fileInputRef} onChange={importCommands} />
                <button onClick={() => setShowCmdModal(false)} style={{ cursor: "pointer", background: "none", border: "none", fontSize: "18px", color: "#999", marginLeft: "10px" }} title="关闭">✖</button>
              </div>
            </div>
            <div style={{ padding: "10px 20px", borderBottom: "1px solid #eee" }}>
              <input type="text" value={quickCmdSearch} onChange={(e) => setQuickCmdSearch(e.target.value)} placeholder="🔍 搜索已有指令..." style={{ width: "100%", padding: "8px 12px", borderRadius: "4px", border: "1px solid #ddd", boxSizing: "border-box", outline: "none", fontSize: "13px" }} />
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: "10px", backgroundColor: "#fafafa" }}>
              {quickCommands.filter(c => c.name.toLowerCase().includes(quickCmdSearch.toLowerCase()) || c.data.toLowerCase().includes(quickCmdSearch.toLowerCase())).map((cmd) => (
                <div key={cmd.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#fff", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "12px", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "5px", flex: 1, marginRight: "15px" }}>
                    <div style={{ fontWeight: "bold", color: "#333", fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>{cmd.name} {cmd.isHex && <span style={{ backgroundColor: "#e91e63", color: "white", fontSize: "10px", padding: "1px 4px", borderRadius: "3px" }}>HEX</span>}</div>
                    <div style={{ fontSize: "13px", color: "#666", fontFamily: "monospace", wordBreak: "break-all" }}>{cmd.data}</div>
                  </div>
                  <button onClick={() => setQuickCommands(prev => prev.filter(c => c.id !== cmd.id))} style={{ background: "#fff1f0", color: "#ff4d4f", cursor: "pointer", fontSize: "13px", padding: "6px 12px", borderRadius: "4px", border: "1px solid #ffa39e" }}>删除</button>
                </div>
              ))}
            </div>
            <div style={{ padding: "15px 20px", borderTop: "1px solid #ddd", display: "flex", flexDirection: "column", gap: "10px", backgroundColor: "#fff" }}>
              <div style={{ fontSize: "14px", fontWeight: "bold", color: "#555" }}>➕ 添加新指令</div>
              <div style={{ display: "flex", gap: "10px" }}>
                <input type="text" value={newCmdName} onChange={(e) => setNewCmdName(e.target.value)} placeholder="指令名称 (如: 重启)" style={{ flex: 1, padding: "8px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px" }} />
                <label style={{ display: "flex", alignItems: "center", gap: "5px", color: newCmdIsHex ? "#e91e63" : "#666", fontSize: "13px", cursor: "pointer" }}><input type="checkbox" checked={newCmdIsHex} onChange={(e) => setNewCmdIsHex(e.target.checked)} />HEX格式</label>
              </div>
              <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
                <textarea value={newCmdData} onChange={(e) => setNewCmdData(e.target.value)} placeholder="指令内容..." style={{ flex: 1, padding: "8px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px", resize: "none", height: "40px", fontFamily: "monospace" }} />
                <button onClick={addQuickCommand} style={{ backgroundColor: "#52c41a", color: "white", border: "none", borderRadius: "4px", padding: "0 20px", height: "58px", fontSize: "14px", cursor: "pointer", fontWeight: "bold" }}>保存添加</button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
