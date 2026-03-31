import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

type LogType = 'send' | 'recv' | 'sys';
interface LogEntry { id: string; type: LogType; text: string; time: string; isHex: boolean; }
interface PortInfo { name: string; desc: string; }
interface QuickCommand { id: string; name: string; data: string; isHex: boolean; }

const getTimestamp = () => {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};

const COMMON_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function App() {
  // 串口参数状态
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
  
  // 日志与发送状态
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sendText, setSendText] = useState("");
  const [appendCrlf, setAppendCrlf] = useState(true);
  const [isHexSend, setIsHexSend] = useState(false);
  const [clearAfterSend, setClearAfterSend] = useState(true); 
  const [showInvisible, setShowInvisible] = useState(false); 
  const [isHexRecv, setIsHexRecv] = useState(false);
  
  const isHexRecvRef = useRef(false);
  const decoderRef = useRef(new TextDecoder("utf-8"));
  const logEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 历史与智能补全
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const draftRef = useRef(""); 
  const [suggestions, setSuggestions] = useState<QuickCommand[]>([]);
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const suggestionsListRef = useRef<HTMLDivElement>(null);

  // 快捷指令与弹窗状态
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
    // 💡 小优化：如果在刷新时发现当前选中的端口已经不存在了，或者还没选端口，就自动选中第一个
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

    return () => { unlistenData.then(f => f()); unlistenDisconnect.then(f => f()); };
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  useEffect(() => {
    if (suggestions.length > 0 && suggestionsListRef.current) {
      const items = suggestionsListRef.current.children;
      if (items[suggestionIdx]) {
        (items[suggestionIdx] as HTMLElement).scrollIntoView({ behavior: "auto", block: "nearest" });
      }
    }
  }, [suggestionIdx, suggestions]);

  const addSysLog = (msg: string) => setLogs(prev => [...prev, { id: crypto.randomUUID(), type: 'sys', text: msg + '\n', time: getTimestamp(), isHex: false }]);

  const toggleConnection = async () => {
    if (isConnected) {
      await invoke("disconnect_port"); setIsConnected(false); addSysLog("串口已手动断开 🔴");
    } else {
      if (!selectedPort) return alert("请先选择设备！");
      try {
        await invoke("connect_port", { 
          portName: selectedPort, baudRate: Number(baudRate), dataBits: Number(dataBits),
          parity, stopBits: Number(stopBits), dtr, rts
        });
        setIsConnected(true); addSysLog(`已连接 ${selectedPort} (${baudRate}, ${dataBits}, ${parity}, ${stopBits}) 🟢`);
        setTimeout(() => { textareaRef.current?.focus(); }, 100);
      } catch (e) { alert("连接失败: " + e); }
    }
  };

  const handleDtrChange = async (val: boolean) => { setDtr(val); if (isConnected) await invoke("set_dtr_rts", { dtr: val, rts }); };
  const handleRtsChange = async (val: boolean) => { setRts(val); if (isConnected) await invoke("set_dtr_rts", { dtr, rts: val }); };

  const executeSend = async (data: string, isHex: boolean, useCrlf: boolean) => {
    if (!isConnected) return alert("请先连接串口！");
    if (!data) return;
    let dataToSend = data;
    if (!isHex && useCrlf) dataToSend += "\r\n"; 
    try {
      await invoke("send_data", { data: dataToSend, isHex: isHex });
      setLogs(prev => [...prev, { id: crypto.randomUUID(), type: 'send', text: dataToSend + (isHex ? '\n' : ''), time: getTimestamp(), isHex: isHex }]);
      return true;
    } catch (e) { alert("发送报错: " + e); return false; }
  };

  const handleSend = async () => {
    const success = await executeSend(sendText, isHexSend, appendCrlf);
    if (success) {
      if (sendText.trim()) setCmdHistory(prev => prev[prev.length - 1] === sendText ? prev : [...prev, sendText]);
      setHistoryIdx(-1); draftRef.current = "";
      if (clearAfterSend) { setSendText(""); setSuggestions([]); }
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setSendText(val);

    const cursor = e.target.selectionStart;
    const textBeforeCursor = val.substring(0, cursor);
    const words = textBeforeCursor.split(/\s+/); 
    const currentWord = words[words.length - 1]; 

    if (currentWord.length > 0) {
      const matches = quickCommands.filter(c => c.data.toLowerCase().startsWith(currentWord.toLowerCase()));
      setSuggestions(matches);
      setSuggestionIdx(0);
    } else { setSuggestions([]); }
  };

  const applySuggestion = (selected: QuickCommand) => {
    if (!textareaRef.current) return;
    const target = textareaRef.current;
    const cursor = target.selectionStart;
    const textBeforeCursor = sendText.substring(0, cursor);
    const words = textBeforeCursor.split(/\s+/);
    const currentWord = words[words.length - 1];
    
    const newTextBefore = textBeforeCursor.substring(0, textBeforeCursor.length - currentWord.length) + selected.data;
    const newText = newTextBefore + sendText.substring(cursor);

    setSendText(newText);
    setSuggestions([]);

    setTimeout(() => {
      target.focus();
      target.selectionStart = target.selectionEnd = newTextBefore.length;
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey)) {
        e.preventDefault(); applySuggestion(suggestions[suggestionIdx]); return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); setSuggestionIdx(prev => (prev > 0 ? prev - 1 : suggestions.length - 1)); return;
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); setSuggestionIdx(prev => (prev < suggestions.length - 1 ? prev + 1 : 0)); return;
      } else if (e.key === 'Escape') {
        setSuggestions([]); return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); handleSend(); }
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
    <div style={{ display: "flex", height: "100vh", backgroundColor: "#f0f2f5", fontFamily: "sans-serif", overflow: "hidden" }}>
      
      {/* ===== 左侧分栏：配置区与快捷执行 ===== */}
      <div style={{ width: "320px", minWidth: "320px", display: "flex", flexDirection: "column", backgroundColor: "#fff", borderRight: "1px solid #ddd", zIndex: 10, boxShadow: "2px 0 8px rgba(0,0,0,0.05)" }}>
        
        {/* 串口配置面板 */}
        <div style={{ padding: "15px", borderBottom: "1px solid #eee" }}>
          <h2 style={{ margin: "0 0 15px 0", fontSize: "18px", color: "#333", display: "flex", alignItems: "center", gap: "8px" }}>🔧 串口设置</h2>
          
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>端口</span>
              {/* 💡 修改点：添加 onClick={fetchPorts} */}
              <select 
                value={selectedPort} 
                onChange={(e) => setSelectedPort(e.target.value)} 
                onMouseEnter={fetchPorts} // 💡 魔法在这里：鼠标一摸上去就偷偷刷新
                onFocus={fetchPorts}      // 保留 focus 为了兼容键盘操作
                disabled={isConnected} 
                style={{ width: "180px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc", cursor: "pointer" }}
              >
                {ports.length === 0 && <option value="">无设备</option>}
                {ports.map((p) => <option key={p.name} value={p.name} title={p.desc}>{p.desc}</option>)}
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>波特率</span>
              <div onDoubleClick={() => !isConnected && setIsCustomBaud(true)} title="双击可手动输入" style={{ width: "180px" }}>
                {isCustomBaud ? (
                  <input 
                    type="number" 
                    value={baudRate} 
                    onChange={(e) => setBaudRate(e.target.value)} 
                    onBlur={() => setIsCustomBaud(false)}
                    autoFocus
                    disabled={isConnected} 
                    style={{ width: "100%", padding: "4px", borderRadius: "4px", border: "1px solid #1890ff", boxSizing: "border-box", outline: "none" }}
                  />
                ) : (
                  <select 
                    value={baudRate} 
                    onChange={(e) => setBaudRate(e.target.value)} 
                    disabled={isConnected} 
                    style={{ width: "100%", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}
                  >
                    {!COMMON_BAUD_RATES.includes(Number(baudRate)) && <option value={baudRate}>{baudRate}</option>}
                    {COMMON_BAUD_RATES.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                )}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>数据位</span>
              <select value={dataBits} onChange={(e) => setDataBits(e.target.value)} disabled={isConnected} style={{ width: "180px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}>
                <option value="8">8</option><option value="7">7</option><option value="6">6</option><option value="5">5</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>校验位</span>
              <select value={parity} onChange={(e) => setParity(e.target.value)} disabled={isConnected} style={{ width: "180px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}>
                <option value="None">None</option><option value="Odd">Odd</option><option value="Even">Even</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#555" }}>停止位</span>
              <select value={stopBits} onChange={(e) => setStopBits(e.target.value)} disabled={isConnected} style={{ width: "180px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}>
                <option value="1">1</option><option value="2">2</option>
              </select>
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
            <span style={{ fontWeight: "bold", color: "#333", fontSize: "14px" }}>🚀 快捷发送</span>
            <button onClick={() => setShowCmdModal(true)} style={{ cursor: "pointer", background: "none", border: "1px solid #d9d9d9", borderRadius: "4px", padding: "4px 8px", fontSize: "12px", backgroundColor: "#fff", transition: "all 0.2s" }}>⚙️ 设置</button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {quickCommands.length === 0 && <div style={{textAlign: "center", color: "#aaa", fontSize: "12px", marginTop: "20px"}}>暂无快捷指令</div>}
            {quickCommands.map((cmd) => (
              <button 
                key={cmd.id} 
                onClick={() => executeSend(cmd.data, cmd.isHex, appendCrlf)} 
                disabled={!isConnected}
                title={cmd.data}
                style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "8px 10px", borderRadius: "6px", border: "1px solid #ddd", background: "#fff", cursor: isConnected ? "pointer" : "not-allowed", opacity: isConnected ? 1 : 0.6, textAlign: "left", transition: "box-shadow 0.2s" }}
              >
                <div style={{ fontWeight: "bold", fontSize: "13px", color: "#333" }}>
                  {cmd.name} {cmd.isHex && <span style={{ color: "#e91e63", fontSize: "10px", marginLeft: "4px", border: "1px solid #f8bbd0", padding: "0 2px", borderRadius: "2px" }}>HEX</span>}
                </div>
                <div style={{ fontSize: "11px", color: "#888", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", width: "100%" }}>
                  {cmd.data}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ===== 右侧分栏：数据流区与发送区 ===== */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "20px", gap: "15px", position: "relative" }}>
        
        {/* 日志控制工具栏 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#fff", padding: "10px 15px", borderRadius: "8px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
          <h2 style={{ margin: 0, fontSize: "16px", color: "#333", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", backgroundColor: isConnected ? "#52c41a" : "#f5222d" }}></span>
            {isConnected ? `数据流监听中 (${selectedPort})` : "未连接设备"}
          </h2>
          <div style={{ display: "flex", gap: "15px", alignItems: "center" }}>
            <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: isHexRecv ? "#e91e63" : "#555", fontSize: "13px" }}><input type="checkbox" checked={isHexRecv} onChange={(e) => setIsHexRecv(e.target.checked)} /> HEX 接收</label>
            <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: "#555", fontSize: "13px" }}><input type="checkbox" checked={showInvisible} onChange={(e) => setShowInvisible(e.target.checked)} /> 显示不可见字符</label>
            <div style={{ width: "1px", height: "16px", backgroundColor: "#ddd", margin: "0 5px" }}></div>
            <button onClick={() => setLogs([])} style={{ cursor: "pointer", padding: "6px 12px", borderRadius: "4px", border: "1px solid #ccc", backgroundColor: "#fff", fontSize: "13px" }}>🗑️ 清空日志</button>
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
        <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", backgroundColor: "#fff", padding: "15px", borderRadius: "8px", boxShadow: "0 -2px 10px rgba(0,0,0,0.02)", position: "relative" }}>
          
          {suggestions.length > 0 && (
            <div style={{ position: 'absolute', bottom: '100%', left: '15px', marginBottom: '8px', backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', zIndex: 100, minWidth: '300px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div ref={suggestionsListRef} style={{ maxHeight: '175px', overflowY: 'auto' }}>
                {suggestions.map((s, idx) => (
                  <div key={s.id} 
                    onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }} 
                    onMouseEnter={() => setSuggestionIdx(idx)}
                    style={{ padding: '8px 12px', backgroundColor: idx === suggestionIdx ? '#e6f7ff' : '#fff', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: '13px', color: '#333' }}>
                    <span style={{ fontWeight: 'bold', color: '#0050b3' }}>{s.data}</span>
                    <span style={{ color: '#888', marginLeft: '10px' }}>({s.name})</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: '4px 12px', fontSize: '11px', color: '#bbb', backgroundColor: '#fafafa', textAlign: 'right', borderTop: '1px solid #eee' }}>按 Tab/Enter 补全，↑/↓/滚轮 切换</div>
            </div>
          )}

          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", gap: "15px" }}>
              <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: isHexSend ? "#e91e63" : "#555" }}><input type="checkbox" checked={isHexSend} onChange={(e) => setIsHexSend(e.target.checked)} />HEX 发送</label>
              <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: "#555" }}><input type="checkbox" checked={appendCrlf} onChange={(e) => setAppendCrlf(e.target.checked)} disabled={isHexSend} />加回车换行</label>
              <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: "#555" }}><input type="checkbox" checked={clearAfterSend} onChange={(e) => setClearAfterSend(e.target.checked)} />发送后清空</label>
            </div>
            <textarea 
              ref={textareaRef} 
              value={sendText} 
              onChange={handleTextareaChange} 
              onKeyDown={handleKeyDown}
              onBlur={() => setTimeout(() => setSuggestions([]), 150)}
              disabled={!isConnected}
              placeholder="在此输入发送内容 (支持补全: Tab, 发送: Enter, 换行: Ctrl+Enter)..." 
              style={{ flex: 1, minHeight: "80px", padding: "10px", borderRadius: "6px", border: "1px solid #d9d9d9", outline: "none", resize: "none", fontFamily: "inherit", fontSize: "14px", lineHeight: "1.5", cursor: isConnected ? "text" : "not-allowed", backgroundColor: isConnected ? "#fff" : "#f5f5f5", userSelect: "auto", WebkitUserSelect: "auto" }}
            />
          </div>
          <button onClick={handleSend} disabled={!isConnected} style={{ height: "80px", width: "120px", cursor: isConnected ? "pointer" : "not-allowed", backgroundColor: isConnected ? "#1890ff" : "#d9d9d9", color: "white", border: "none", borderRadius: "6px", fontWeight: "bold", fontSize: "16px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "5px", transition: "all 0.2s" }}>
            <span>发送</span>
            <span style={{ fontSize: "12px", fontWeight: "normal", opacity: 0.8 }}>(Enter)</span>
          </button>
        </div>
      </div>

      {/* ===== 弹窗：快捷指令管理设置 ===== */}
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
              {quickCommands.filter(c => c.name.toLowerCase().includes(quickCmdSearch.toLowerCase()) || c.data.toLowerCase().includes(quickCmdSearch.toLowerCase())).length === 0 && (
                <div style={{ textAlign: "center", color: "#999", marginTop: "40px" }}>无匹配的指令</div>
              )}
              {quickCommands.filter(c => c.name.toLowerCase().includes(quickCmdSearch.toLowerCase()) || c.data.toLowerCase().includes(quickCmdSearch.toLowerCase())).map((cmd) => (
                <div key={cmd.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#fff", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "12px", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "5px", flex: 1, marginRight: "15px" }}>
                    <div style={{ fontWeight: "bold", color: "#333", fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
                      {cmd.name}
                      {cmd.isHex && <span style={{ backgroundColor: "#e91e63", color: "white", fontSize: "10px", padding: "1px 4px", borderRadius: "3px" }}>HEX</span>}
                    </div>
                    <div style={{ fontSize: "13px", color: "#666", fontFamily: "monospace", wordBreak: "break-all" }}>{cmd.data}</div>
                  </div>
                  <button onClick={() => setQuickCommands(prev => prev.filter(c => c.id !== cmd.id))} style={{ border: "none", background: "#fff1f0", color: "#ff4d4f", cursor: "pointer", fontSize: "13px", padding: "6px 12px", borderRadius: "4px", border: "1px solid #ffa39e" }}>删除</button>
                </div>
              ))}
            </div>

            <div style={{ padding: "15px 20px", borderTop: "1px solid #ddd", display: "flex", flexDirection: "column", gap: "10px", backgroundColor: "#fff" }}>
              <div style={{ fontSize: "14px", fontWeight: "bold", color: "#555" }}>➕ 添加新指令</div>
              <div style={{ display: "flex", gap: "10px" }}>
                <input type="text" value={newCmdName} onChange={(e) => setNewCmdName(e.target.value)} placeholder="指令名称 (如: 重启)" style={{ flex: 1, padding: "8px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px" }} />
                <label style={{ display: "flex", alignItems: "center", gap: "5px", color: newCmdIsHex ? "#e91e63" : "#666", fontSize: "13px", cursor: "pointer" }}><input type="checkbox" checked={newCmdIsHex} onChange={(e) => setNewCmdIsHex(e.target.checked)} />使用 HEX</label>
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
