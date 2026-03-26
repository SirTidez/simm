use crate::types::LogLevel;
use log::{Level, Metadata, Record};
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

struct LogMessage {
    level: LogLevel,
    message: String,
}

pub struct GlobalLogger {
    sender: Mutex<Option<Sender<LogMessage>>>,
}

impl GlobalLogger {
    pub fn new() -> Self {
        Self {
            sender: Mutex::new(None),
        }
    }

    pub fn initialize_logger_service(&self) {
        // Create a channel for sending log messages
        let (tx, rx) = mpsc::channel::<LogMessage>();

        // Store the sender
        if let Ok(mut sender) = self.sender.lock() {
            *sender = Some(tx);
        }

        // Start a background thread to process log messages
        std::thread::spawn(move || {
            // Create a Tokio runtime for this thread
            let rt = tokio::runtime::Runtime::new().unwrap();

            // Initialize the LoggerService
            let logger_service = rt.block_on(async {
                match crate::services::logger::LoggerService::new() {
                    Ok(service) => {
                        eprintln!("[GlobalLogger] LoggerService initialized successfully");
                        Some(service)
                    }
                    Err(e) => {
                        eprintln!("[GlobalLogger] Failed to initialize LoggerService: {}", e);
                        None
                    }
                }
            });

            // Process log messages
            while let Ok(log_msg) = rx.recv() {
                if let Some(ref service) = logger_service {
                    rt.block_on(async {
                        service
                            .log(
                                log_msg.level,
                                &format!("[Server] {}", log_msg.message),
                                None,
                            )
                            .await;
                    });
                }
            }
        });

        eprintln!("[GlobalLogger] Background logging thread started");
    }

    fn send_to_file(&self, level: LogLevel, message: String) {
        if let Ok(sender) = self.sender.lock() {
            if let Some(tx) = sender.as_ref() {
                let _ = tx.send(LogMessage { level, message });
            }
        }
    }
}

impl log::Log for GlobalLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        // Log everything at Info level and above
        metadata.level() <= Level::Info
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            let message = format!("{}", record.args());
            let sanitized_message =
                crate::services::logger::LoggerService::sanitize_log_text(&message);

            // Always print to console immediately (synchronous)
            eprintln!("[{}] {}", record.level(), sanitized_message);

            // Send to file logger (non-blocking)
            let level = match record.level() {
                Level::Error => LogLevel::Error,
                Level::Warn => LogLevel::Warn,
                Level::Info => LogLevel::Info,
                Level::Debug => LogLevel::Debug,
                Level::Trace => LogLevel::Debug,
            };

            self.send_to_file(level, sanitized_message);
        }
    }

    fn flush(&self) {
        // Flush is handled by the background thread
    }
}

static GLOBAL_LOGGER: once_cell::sync::Lazy<GlobalLogger> =
    once_cell::sync::Lazy::new(|| GlobalLogger::new());
static LOGGER_SERVICE_STARTED: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

/// Initialize the global logger
pub fn init_global_logger() {
    // Set the global logger
    if let Err(e) = log::set_logger(&*GLOBAL_LOGGER) {
        eprintln!("[GlobalLogger] Failed to set global logger: {}", e);
        return;
    }

    // Set max log level
    log::set_max_level(log::LevelFilter::Info);

    eprintln!("[GlobalLogger] Global logger initialized");
}

/// Initialize the LoggerService for the global logger (starts background thread)
pub fn init_logger_service() {
    if LOGGER_SERVICE_STARTED.swap(true, Ordering::SeqCst) {
        eprintln!("[GlobalLogger] LoggerService already started");
        return;
    }
    GLOBAL_LOGGER.initialize_logger_service();
}
