#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use std::thread;
use tauri::{Emitter, State};

struct PortState {
    should_read: Arc<AtomicBool>,
    serial_writer: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
}

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

fn map_data_bits(bits: u8) -> serialport::DataBits {
    match bits {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    }
}

fn map_parity(parity: &str) -> serialport::Parity {
    match parity {
        "Odd" => serialport::Parity::Odd,
        "Even" => serialport::Parity::Even,
        _ => serialport::Parity::None,
    }
}

fn map_stop_bits(bits: u8) -> serialport::StopBits {
    match bits {
        2 => serialport::StopBits::Two,
        _ => serialport::StopBits::One,
    }
}

#[tauri::command]
fn connect_port(
    app_handle: tauri::AppHandle,
    state: State<'_, PortState>,
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    parity: String,
    stop_bits: u8,
    dtr: bool,
    rts: bool,
) -> Result<(), String> {
    state.should_read.store(false, Ordering::Relaxed);
    thread::sleep(Duration::from_millis(50));

    let port = serialport::new(&port_name, baud_rate)
        .data_bits(map_data_bits(data_bits))
        .parity(map_parity(&parity))
        .stop_bits(map_stop_bits(stop_bits))
        .timeout(Duration::from_millis(50))
        .open();

    match port {
        Ok(mut serial) => {
            let _ = serial.write_data_terminal_ready(dtr);
            let _ = serial.write_request_to_send(rts);

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
fn set_dtr_rts(state: State<'_, PortState>, dtr: bool, rts: bool) -> Result<(), String> {
    let mut writer_guard = state.serial_writer.lock().unwrap();
    if let Some(writer) = writer_guard.as_mut() {
        let _ = writer.write_data_terminal_ready(dtr);
        let _ = writer.write_request_to_send(rts);
        Ok(())
    } else {
        Err("串口未连接".to_string())
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

// 💡 新增：异步分块发送文件功能
#[tauri::command]
fn send_file(app_handle: tauri::AppHandle, state: State<'_, PortState>, file_path: String) -> Result<(), String> {
    let writer_opt = {
        let mut guard = state.serial_writer.lock().unwrap();
        if let Some(writer) = guard.as_mut() {
            writer.try_clone().ok()
        } else {
            None
        }
    };

    if let Some(mut writer) = writer_opt {
        // 新开线程发送文件，防止阻塞主进程
        thread::spawn(move || {
            let mut file = match File::open(&file_path) {
                Ok(f) => f,
                Err(e) => {
                    let _ = app_handle.emit("sys-log", format!("无法打开文件: {}", e));
                    return;
                }
            };

            let mut buffer = [0; 1024]; // 每次发送 1KB
            let _ = app_handle.emit("sys-log", format!("开始发送文件: {} 📁", file_path));

            loop {
                match file.read(&mut buffer) {
                    Ok(0) => {
                        let _ = app_handle.emit("sys-log", "文件发送完成 ✅".to_string());
                        break;
                    }
                    Ok(n) => {
                        if let Err(e) = writer.write_all(&buffer[..n]) {
                            let _ = app_handle.emit("sys-log", format!("文件发送中断: {}", e));
                            break;
                        }
                        let _ = writer.flush();
                    }
                    Err(e) => {
                        let _ = app_handle.emit("sys-log", format!("读取文件错误: {}", e));
                        break;
                    }
                }
            }
        });
        Ok(())
    } else {
        Err("串口未连接".to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(PortState {
            should_read: Arc::new(AtomicBool::new(false)),
            serial_writer: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            get_available_ports, connect_port, disconnect_port, send_data, set_dtr_rts, send_file // 💡 注册 send_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
