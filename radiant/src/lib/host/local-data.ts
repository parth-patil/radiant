/** Persistent browser-side data, partitioned by WebView origin. */
let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve,reject) => {
      const request = indexedDB.open('radiant-local-data',2);
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(new Error('Close an older Radiant window to use local history.')); };
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (event.oldVersion < 1) {
          db.createObjectStore('images');
          const snapshots = db.createObjectStore('snapshots',{keyPath:'id'});
          snapshots.createIndex('document','docId');
        }
        if (event.oldVersion < 2) {
          const undo = db.createObjectStore('undo',{keyPath:'key'});
          undo.createIndex('document',['docId','slot']);
          undo.createIndex('revision',['docId','slot','at']);
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
    }).catch(error => {database=undefined;throw error;});
  }
  return database;
}

export async function localData<T>(table:'images'|'snapshots'|'undo', mode:IDBTransactionMode, request:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(table,mode);
    const operation=request(tx.objectStore(table));
    tx.oncomplete=()=>resolve(operation.result);
    tx.onerror=tx.onabort=()=>reject(tx.error ?? operation.error);
  });
}
