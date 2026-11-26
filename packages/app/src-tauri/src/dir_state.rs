//! 跨窗口传递「打开目录」请求：single-instance / CLI 参数 / macOS Opened
//! 在窗口创建前到达时先存入 pending，窗口首帧后由前端 get_cli_directory
//! 一次性消费（同一套契约见 OpenCodeUI 的 dir_state.rs）。

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, serde::Serialize)]
pub struct OpenDirectoryRequest {
    pub directory: String,
    pub explicit: bool,
    #[serde(flatten)]
    pub source: DirectorySource,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "source", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DirectorySource {
    Local,
    Backend { server_id: String, server_url: String },
}

impl OpenDirectoryRequest {
    pub fn local(directory: String, explicit: bool) -> Self {
        Self { directory, explicit, source: DirectorySource::Local }
    }
}

#[derive(Default)]
pub struct OpenDirectoryState {
    pending: Mutex<HashMap<String, OpenDirectoryRequest>>,
}

impl OpenDirectoryState {
    /// 为指定窗口登记待消费的目录。
    pub fn pin(&self, window_label: &str, request: OpenDirectoryRequest) {
        self.pending
            .lock()
            .expect("open directory state poisoned")
            .insert(window_label.to_string(), request);
    }

    /// 一次性读取并移除指定窗口的目录。
    pub fn take(&self, window_label: &str) -> Option<OpenDirectoryRequest> {
        self.pending
            .lock()
            .expect("open directory state poisoned")
            .remove(window_label)
    }
}

/// 获取启动时传入的目录路径（一次性读取后清空）。
#[tauri::command]
pub fn get_cli_directory(
    window: tauri::Window,
    state: tauri::State<'_, OpenDirectoryState>,
) -> Option<OpenDirectoryRequest> {
    state.take(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_keep_launch_intent_and_window_ownership() {
        let state = OpenDirectoryState::default();
        state.pin("main", OpenDirectoryRequest::local("C:/shortcut".into(), false));
        state.pin("second", OpenDirectoryRequest {
            directory: "/srv/project".into(),
            explicit: true,
            source: DirectorySource::Backend { server_id: "remote".into(), server_url: "https://remote.test".into() },
        });
        let request = state.take("main").unwrap();
        assert_eq!(request.directory, "C:/shortcut");
        assert!(!request.explicit);
        assert!(matches!(request.source, DirectorySource::Local));
        assert!(state.take("main").is_none());
        let second = state.take("second").unwrap();
        assert_eq!(serde_json::to_value(second).unwrap(), serde_json::json!({
            "directory": "/srv/project", "explicit": true, "source": "backend",
            "serverId": "remote", "serverUrl": "https://remote.test",
        }));
    }
}
