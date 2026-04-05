import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type LogType = 'send' | 'recv' | 'sys';
export interface LogEntry { 
  id: string; 
  type: LogType; 
  text: string; 
  time: string; 
  timestampMs: number; // 💡 用于计算时间差
  isHex: boolean; 
  isContinuous?: boolean; // 💡 控制是否隐藏时间戳
}
export interface QuickCommand { id: string; name: string; data: string; isHex: boolean; }
export type ViewMode = 'basic' | 'oscilloscope' | 'script' | 'GNSSviewer';

export const getTimestamp = () => {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};

interface SerialState {
  activeView: ViewMode;
  setActiveView: (view: ViewMode) => void;
  isConnected: boolean;
  setIsConnected: (status: boolean) => void;
  
  logs: LogEntry[];
  addLog: (log: LogEntry) => void;
  addLogsBatch: (logs: LogEntry[]) => void; // 💡 批量添加
  clearLogs: () => void;
  
  isHexRecv: boolean;
  setIsHexRecv: (status: boolean) => void;
  executeSend: (data: string, isHex: boolean, useCrlf: boolean) => Promise<boolean>;
}

// 定义安全上限常量
const MAX_LOG_LIMIT = 100000;

export const useSerialStore = create<SerialState>((set, get) => ({
  activeView: 'basic',
  setActiveView: (view) => set({ activeView: view }),
  isConnected: false,
  setIsConnected: (status) => set({ isConnected: status }),
  logs: [],

  addLog: (log) => set((state) => {
    const newLogs = [...state.logs];
    const lastLog = newLogs.length > 0 ? newLogs[newLogs.length - 1] : null;
    
    // 判断是否连续 (同类型，且相差不到 2000 毫秒)
    if (lastLog && log.type === lastLog.type && log.type !== 'sys' && (log.timestampMs - lastLog.timestampMs < 2000)) {
      log.isContinuous = true;
    } else {
      log.isContinuous = false;
    }
    
    newLogs.push(log);
    
    // 💡 10万条极高安全兜底上限
    if (newLogs.length > MAX_LOG_LIMIT) {
      return { logs: newLogs.slice(newLogs.length - MAX_LOG_LIMIT) };
    }
    return { logs: newLogs };
  }),

  addLogsBatch: (entries) => set((state) => {
    const newLogs = [...state.logs];
    let lastLog = newLogs.length > 0 ? newLogs[newLogs.length - 1] : null;
    
    entries.forEach(log => {
      if (lastLog && log.type === lastLog.type && log.type !== 'sys' && (log.timestampMs - lastLog.timestampMs < 2000)) {
        log.isContinuous = true;
      } else {
        log.isContinuous = false;
      }
      newLogs.push(log);
      lastLog = log;
    });
    
    // 💡 10万条极高安全兜底上限
    if (newLogs.length > MAX_LOG_LIMIT) {
      return { logs: newLogs.slice(newLogs.length - MAX_LOG_LIMIT) };
    }
    return { logs: newLogs };
  }),

  clearLogs: () => set({ logs: [] }),
  isHexRecv: false,
  setIsHexRecv: (status) => set({ isHexRecv: status }),
  
  executeSend: async (data, isHex, useCrlf) => {
    const state = get();
    if (!state.isConnected) { alert("请先连接串口！"); return false; }
    if (!data) return false;
    
    let dataToSend = data;
    if (!isHex && useCrlf) dataToSend += "\r\n"; 
    
    try {
      await invoke("send_data", { data: dataToSend, isHex: isHex });
      state.addLog({ 
        id: crypto.randomUUID(), type: 'send', text: dataToSend + (isHex ? '\n' : ''), 
        time: getTimestamp(), timestampMs: Date.now(), isHex: isHex 
      });
      return true;
    } catch (e) { 
      alert("发送报错: " + e); return false; 
    }
  }
}));
