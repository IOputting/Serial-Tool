#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use std::thread;
use std::io::Write;
use tauri::{Emitter, State};

struct PortState {
    should_read: Arc<AtomicBool>,
    serial_writer: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
}

// 💡 新增：包含设备名称的端口信息结构体
#[derive(serde::Serialize)]
struct PortInfo {
    name: String,
    desc: String,
}

#[tauri::command]
fn get_available_ports() -> Vec<PortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let mut desc = p.port_name.clone();
            // 💡 尝试提取 USB 设备的产品名称或制造商（如 CH340, ST-Link）
            if let serialport::SerialPortType::UsbPort(usb_info) = p.port_type {
                if let Some(product) = usb_info.product {
                    desc = format!("{} ({})", p.port_name, product);
                } else if let Some(mfg) = usb_info.manufacturer {
                    desc = format!("{} ({})", p.port_name, mfg);
                }
            }
            PortInfo { name: p.port_name, desc }
        })
        .collect()
}

#[tauri::command]
fn connect_port(
    app_handle: tauri::AppHandle,
    state: State<'_, PortState>,
    port_name: String,
    baud_rate: u32,
) -> Result<(), String> {
    state.should_read.store(false, Ordering::Relaxed);
    thread::sleep(Duration::from_millis(50));

    let port = serialport::new(&port_name, baud_rate)
        .timeout(Duration::from_millis(50))
        .open();

    match port {
        Ok(mut serial) => {
            let writer = serial.try_clone().map_err(|e| format!("克隆串口句柄失败: {}", e))?;
            let mut state_writer = state.serial_writer.lock().unwrap();
            *state_writer = Some(writer);

            let should_read = Arc::clone(&state.should_read);
            should_read.store(true, Ordering::Relaxed);

            thread::spawn(move || {
                let mut serial_buf: Vec<u8> = vec![0; 2048];
                while should_read.load(Ordering::Relaxed) {
                    match serial.read(serial_buf.as_mut_slice()) {
                        Ok(t) if t > 0 => {
                            let data_bytes = serial_buf[..t].to_vec();
                            let _ = app_handle.emit("serial-data", data_bytes);
                        }
                        Ok(_) => (),
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => (),
                        Err(e) => {
                            let _ = app_handle.emit("serial-disconnected", e.to_string());
                            break;
                        }
                    }
                }
            });
            Ok(())
        }
        Err(e) => Err(format!("无法打开串口: {}", e)),
    }
}

#[tauri::command]
fn disconnect_port(state: State<'_, PortState>) {
    state.should_read.store(false, Ordering::Relaxed);
    let mut state_writer = state.serial_writer.lock().unwrap();
    *state_writer = None;
}

#[tauri::command]
fn send_data(state: State<'_, PortState>, data: String, is_hex: bool) -> Result<(), String> {
    let mut writer_guard = state.serial_writer.lock().unwrap();
    if let Some(writer) = writer_guard.as_mut() {
        let bytes_to_send = if is_hex {
            let clean_hex = data.replace(" ", "");
            if clean_hex.len() % 2 != 0 { return Err("HEX 格式错误：字符数量必须是偶数".to_string()); }
            let mut hex_bytes = Vec::new();
            for i in (0..clean_hex.len()).step_by(2) {
                let byte_str = &clean_hex[i..i+2];
                let byte = u8::from_str_radix(byte_str, 16)
                    .map_err(|_| "包含无效的 HEX 字符".to_string())?;
                hex_bytes.push(byte);
            }
            hex_bytes
        } else {
            data.into_bytes()
        };

        writer.write_all(&bytes_to_send).map_err(|e| format!("写入失败: {}", e))?;
        writer.flush().map_err(|e| format!("强制发送失败: {}", e))?;
        Ok(())
    } else {
        Err("串口未连接".to_string())
    }
}

// ... 前面的代码保持不变 ...

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init()) // 💡 新增：对话框插件
        .plugin(tauri_plugin_fs::init())     // 💡 新增：文件系统插件
        .manage(PortState {
            should_read: Arc::new(AtomicBool::new(false)),
            serial_writer: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            get_available_ports, connect_port, disconnect_port, send_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
