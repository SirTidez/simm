use crate::types::LogLevel;
use log::{Level, Metadata, Record};
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::Mutex;

const LOG_QUEUE_CAPACITY: usize = 4096;
static DROPPED_LOG_MESSAGES: AtomicUsize = AtomicUsize::new(0);
static FALLBACK_CRITICAL_LOG_MESSAGES: AtomicUsize = AtomicUsize::new(0);

struct LogMessage {
    level: LogLevel,
    message: String,
}

pub struct GlobalLogger {
    sender: Mutex<Option<SyncSender<LogMessage>>>,
}

impl GlobalLogger {
    pub fn new() -> Self {
        Self {
            sender: Mutex::new(None),
        }
    }

    pub fn initialize_logger_service(&self) {
        // Create a channel for sending log messages
        let (tx, rx) = mpsc::sync_channel::<LogMessage>(LOG_QUEUE_CAPACITY);

        // Store the sender
        if let Ok(mut sender) = self.sender.lock() {
            *sender = Some(tx);
        }

        // Start a background thread to process log messages
        std::thread::spawn(move || {
            // Create a Tokio runtime for this thread
            let rt = match tokio::runtime::Runtime::new() {
                Ok(runtime) => runtime,
                Err(error) => {
                    LOGGER_SERVICE_STARTED.store(false, Ordering::SeqCst);
                    eprintln!(
                        "[GlobalLogger] Failed to create runtime for LoggerService: {}",
                        error
                    );
                    return;
                }
            };

            // Initialize the LoggerService
            let logger_service = rt.block_on(async {
                match crate::services::logger::LoggerService::new() {
                    Ok(service) => {
                        eprintln!("[GlobalLogger] LoggerService initialized successfully");
                        Some(service)
                    }
                    Err(e) => {
                        LOGGER_SERVICE_STARTED.store(false, Ordering::SeqCst);
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
                match tx.try_send(LogMessage { level, message }) {
                    Ok(()) => {}
                    Err(TrySendError::Full(log_message)) => {
                        if matches!(log_message.level, LogLevel::Warn | LogLevel::Error) {
                            // Never block an application thread behind disk logging. The
                            // synchronous console copy emitted by `log` remains available,
                            // and this counter makes queue saturation observable.
                            let fallback =
                                FALLBACK_CRITICAL_LOG_MESSAGES.fetch_add(1, Ordering::Relaxed) + 1;
                            if fallback == 1 || fallback % 100 == 0 {
                                eprintln!(
                                    "[GlobalLogger] Log queue saturated; {} warn/error record(s) retained only in the console fallback",
                                    fallback
                                );
                            }
                            return;
                        }
                        let dropped = DROPPED_LOG_MESSAGES.fetch_add(1, Ordering::Relaxed) + 1;
                        if dropped == 1 || dropped % 1000 == 0 {
                            eprintln!(
                                "[GlobalLogger] Log queue saturated; dropped {} low-priority record(s)",
                                dropped
                            );
                        }
                    }
                    Err(TrySendError::Disconnected(_)) => {}
                }
            }
        }
    }
}

impl log::Log for GlobalLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let message_level = match metadata.level() {
            Level::Error => LogLevel::Error,
            Level::Warn => LogLevel::Warn,
            Level::Info => LogLevel::Info,
            Level::Debug | Level::Trace => LogLevel::Debug,
        };

        crate::services::logger::LoggerService::should_log(
            message_level,
            crate::services::logger::LoggerService::current_log_level(),
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warn_falls_back_without_waiting_when_queue_is_full() {
        let logger = GlobalLogger::new();
        let (tx, rx) = mpsc::sync_channel(1);
        tx.try_send(LogMessage {
            level: LogLevel::Info,
            message: "already queued".to_string(),
        })
        .unwrap();
        *logger.sender.lock().unwrap() = Some(tx);

        let before = FALLBACK_CRITICAL_LOG_MESSAGES.load(Ordering::Relaxed);
        logger.send_to_file(LogLevel::Warn, "fallback".to_string());
        let after = FALLBACK_CRITICAL_LOG_MESSAGES.load(Ordering::Relaxed);

        assert!(after > before);
        assert_eq!(rx.try_recv().unwrap().message, "already queued");
    }
}

/// Initialize the global logger
pub fn init_global_logger() {
    // Set the global logger
    if let Err(e) = log::set_logger(&*GLOBAL_LOGGER) {
        eprintln!("[GlobalLogger] Failed to set global logger: {}", e);
        return;
    }

    // Set max log level from the shared logger state.
    log::set_max_level(crate::services::logger::LoggerService::level_filter(
        crate::services::logger::LoggerService::current_log_level(),
    ));

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
