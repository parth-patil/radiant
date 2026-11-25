//! Narrow EventKit adapter. No calendar enumeration or arbitrary item lookup is exposed over IPC.
use block2::RcBlock;
use objc2::{
    class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool},
    sel,
};
use objc2_foundation::{NSError, NSString};

#[link(name = "EventKit", kind = "framework")]
unsafe extern "C" {}

const REMINDERS: usize = 1;

pub(super) struct Store(Retained<AnyObject>);

impl Store {
    pub(super) fn open(request: bool) -> Result<Self, String> {
        // EventKit owns its asynchronous completion block; keep the store alive until it responds.
        let status: isize =
            unsafe { msg_send![class!(EKEventStore), authorizationStatusForEntityType: REMINDERS] };
        if status != 3 && (!request || status != 0) {
            return Err("Allow Radiant to access Reminders in System Settings → Privacy & Security → Reminders.".into());
        }
        let store: Retained<AnyObject> = unsafe { msg_send![class!(EKEventStore), new] };
        if status == 3 {
            return Ok(Self(store));
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let complete = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe {
            let modern: Bool = msg_send![&*store, respondsToSelector: sel!(requestFullAccessToRemindersWithCompletion:)];
            if modern.as_bool() {
                let _: () =
                    msg_send![&*store, requestFullAccessToRemindersWithCompletion: &*complete];
            } else {
                let _: () = msg_send![&*store, requestAccessToEntityType: REMINDERS, completion: &*complete];
            }
        }
        match rx.recv_timeout(std::time::Duration::from_secs(120)) {
            Ok(true) => Ok(Self(store)),
            Ok(false) => Err("Reminders access was denied. You can enable it in System Settings → Privacy & Security.".into()),
            Err(_) => Err("Reminders permission request timed out.".into()),
        }
    }

    fn item(&self, id: &str) -> Option<Retained<AnyObject>> {
        let id = NSString::from_str(id);
        unsafe {
            let item: Option<Retained<AnyObject>> =
                msg_send![&*self.0, calendarItemWithIdentifier: &*id];
            let item = item?;
            let is_reminder: Bool = msg_send![&*item, isKindOfClass: class!(EKReminder)];
            is_reminder.as_bool().then_some(item)
        }
    }

    fn save(&self, reminder: &AnyObject) -> Result<(), String> {
        let mut error: *mut NSError = std::ptr::null_mut();
        let saved: Bool = unsafe {
            msg_send![&*self.0, saveReminder: reminder, commit: Bool::YES, error: &mut error]
        };
        if saved.as_bool() {
            Ok(())
        } else {
            Err("Reminders could not save the linked task.".into())
        }
    }

    pub(super) fn create(&self, title: &str, done: bool) -> Result<String, String> {
        let title = NSString::from_str(title);
        unsafe {
            let calendar: Option<Retained<AnyObject>> =
                msg_send![&*self.0, defaultCalendarForNewReminders];
            let calendar = calendar.ok_or("Choose a default list in Reminders first.")?;
            let reminder: Retained<AnyObject> =
                msg_send![class!(EKReminder), reminderWithEventStore: &*self.0];
            let _: () = msg_send![&*reminder, setCalendar: &*calendar];
            let _: () = msg_send![&*reminder, setTitle: &*title];
            let _: () = msg_send![&*reminder, setCompleted: Bool::new(done)];
            self.save(&reminder)?;
            let id: Retained<NSString> = msg_send![&*reminder, calendarItemIdentifier];
            Ok(id.to_string())
        }
    }

    pub(super) fn completion(&self, id: &str) -> Result<bool, String> {
        let item = self
            .item(id)
            .ok_or("This linked reminder is unavailable. Disconnect it to create a new link.")?;
        let done: Bool = unsafe { msg_send![&*item, isCompleted] };
        Ok(done.as_bool())
    }

    pub(super) fn set_completion(&self, id: &str, done: bool) -> Result<(), String> {
        let item = self.item(id).ok_or("The linked reminder is unavailable.")?;
        unsafe {
            let _: () = msg_send![&*item, setCompleted: Bool::new(done)];
        }
        self.save(&item)
    }

    pub(super) fn remove_created(&self, id: &str) {
        if let Some(item) = self.item(id) {
            let mut error: *mut NSError = std::ptr::null_mut();
            unsafe {
                let _: Bool = msg_send![&*self.0, removeReminder: &*item, commit: Bool::YES, error: &mut error];
            }
        }
    }
}
