//! The shared remote/web quota reads and updates the existing web device record under its store's
//! one lock. There is no second quota map or read-then-write reservation race.

use crate::remote::quota::{QuotaRecord, QuotaStore};
use crate::server::Fault;

use super::devices::{Effect, Patch};
use super::store::FileDevices;

impl QuotaStore for FileDevices {
    fn update(
        &self,
        device_id: &str,
        change: &mut dyn FnMut(&mut QuotaRecord) -> bool,
    ) -> Result<bool, Fault> {
        self.apply(None, |book| {
            let Some(device) = book.get(device_id) else {
                return (Ok(false), Effect::default());
            };
            let record = || -> Result<QuotaRecord, Fault> {
                Ok(QuotaRecord {
                    limits: device
                        .limits
                        .as_ref()
                        .map(|v| serde_json::from_value(v.clone()))
                        .transpose()
                        .map_err(|e| Fault::new("quota_record", e.to_string()))?,
                    usage: device
                        .usage
                        .as_ref()
                        .map(|v| serde_json::from_value(v.clone()))
                        .transpose()
                        .map_err(|e| Fault::new("quota_record", e.to_string()))?,
                })
            };
            let mut record = match record() {
                Ok(record) => record,
                Err(error) => return (Err(error), Effect::default()),
            };
            if !change(&mut record) {
                return (Ok(true), Effect::default());
            }
            let patch = || -> Result<Patch, Fault> {
                Ok(Patch {
                    limits: Some(
                        record
                            .limits
                            .map(serde_json::to_value)
                            .transpose()
                            .map_err(|e| Fault::new("quota_record", e.to_string()))?,
                    ),
                    usage: Some(
                        record
                            .usage
                            .map(serde_json::to_value)
                            .transpose()
                            .map_err(|e| Fault::new("quota_record", e.to_string()))?,
                    ),
                })
            };
            match patch() {
                Ok(patch) => {
                    let (exists, effect) = book.update(device_id, patch);
                    (Ok(exists), effect)
                }
                Err(error) => (Err(error), Effect::default()),
            }
        })
    }
}
