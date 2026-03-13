use chrono::Utc;
use tauri::{AppHandle, Runtime};

use crate::types::{DownloadStatus, TrackedDownload, TrackedDownloadKind};

pub fn new_download_id(prefix: &str) -> String {
    format!("{}-{}", prefix, Utc::now().timestamp_millis())
}

pub fn start_file_download(
    id: String,
    kind: TrackedDownloadKind,
    label: impl Into<String>,
    context_label: impl Into<String>,
    message: Option<String>,
) -> TrackedDownload {
    TrackedDownload {
        id,
        kind,
        label: label.into(),
        context_label: context_label.into(),
        status: DownloadStatus::Downloading,
        progress: 0.0,
        downloaded_files: Some(0),
        total_files: Some(1),
        message,
        error: None,
        started_at: Utc::now(),
        finished_at: None,
    }
}

pub fn complete_file_download(
    download: &TrackedDownload,
    message: Option<String>,
) -> TrackedDownload {
    TrackedDownload {
        status: DownloadStatus::Completed,
        progress: 100.0,
        downloaded_files: Some(1),
        total_files: Some(1),
        message,
        error: None,
        finished_at: Some(Utc::now()),
        ..download.clone()
    }
}

pub fn fail_file_download(
    download: &TrackedDownload,
    error: impl Into<String>,
    message: Option<String>,
) -> TrackedDownload {
    TrackedDownload {
        status: DownloadStatus::Error,
        progress: download.progress,
        downloaded_files: Some(0),
        total_files: Some(1),
        message,
        error: Some(error.into()),
        finished_at: Some(Utc::now()),
        ..download.clone()
    }
}

#[allow(dead_code)]
pub fn cancelled_file_download(download: &TrackedDownload, message: Option<String>) -> TrackedDownload {
    TrackedDownload {
        status: DownloadStatus::Cancelled,
        progress: download.progress,
        downloaded_files: Some(0),
        total_files: Some(1),
        message,
        error: None,
        finished_at: Some(Utc::now()),
        ..download.clone()
    }
}

pub fn emit<R: Runtime>(
    app: &AppHandle<R>,
    download: TrackedDownload,
) -> Result<(), tauri::Error> {
    crate::events::emit_tracked_download_updated(app, download)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_download_lifecycle_sets_terminal_fields() {
        let started = start_file_download(
            "download-1".to_string(),
            TrackedDownloadKind::Framework,
            "MelonLoader.zip",
            "Test Env",
            Some("Downloading asset".to_string()),
        );
        assert!(matches!(started.status, DownloadStatus::Downloading));
        assert_eq!(started.downloaded_files, Some(0));
        assert_eq!(started.total_files, Some(1));
        assert!(started.finished_at.is_none());

        let completed = complete_file_download(&started, Some("Asset downloaded".to_string()));
        assert!(matches!(completed.status, DownloadStatus::Completed));
        assert_eq!(completed.downloaded_files, Some(1));
        assert_eq!(completed.total_files, Some(1));
        assert!(completed.finished_at.is_some());

        let failed = fail_file_download(&started, "boom", Some("Download failed".to_string()));
        assert!(matches!(failed.status, DownloadStatus::Error));
        assert_eq!(failed.error.as_deref(), Some("boom"));
        assert!(failed.finished_at.is_some());
    }
}
