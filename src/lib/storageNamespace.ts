/**
 * 本应用的存储命名。
 *
 * IndexedDB 与 localStorage 都按 origin 隔离、不按路径，如果与上游原版部署在同一
 * host:port（哪怕路径不同），同名存储会互相污染。因此这里统一使用项目自己的名字，
 * 并在启动时把旧命名下的数据迁移过来。
 */
export const STORAGE_NAME = 'image-workbench'

/** 上游原版使用的存储命名，只在迁移时读取。 */
export const LEGACY_STORAGE_NAME = 'gpt-image-playground'

/** 记录「旧命名已迁移」的标记，避免每次启动都去探测旧库。 */
export const LEGACY_MIGRATION_FLAG_KEY = `${STORAGE_NAME}.legacy-storage-migrated`

/** 除主存储键外，本应用在 localStorage 里使用的其他键。 */
export const COPY_IMPORT_URL_OPTIONS_KEY = `${STORAGE_NAME}.copy-import-url-options`
