import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createConnection } from 'mysql2/promise'
import { env } from './conf/env'
import { logger } from './common/logger'

export const MIGRATION_HISTORY_TABLE = 'waitqueue_schema_migrations'
export const MIGRATION_LOCK_NAME = 'waitqueue_schema_migrations'
export const V3_NORMALIZE_SCRIPT = 'V3__normalize_queue_schema.sql'

const VERSIONED_MIGRATION_PATTERN = /^V([1-9]\d*)__([^/]+)\.sql$/

export interface VersionedMigrationFile {
	version: number
	description: string
	filename: string
}

export interface Migration extends VersionedMigrationFile {
	sql: string
	checksum: string
}

export interface AppliedMigration {
	version: number
	filename: string
	checksum: string
}

export interface MigrationConnection {
	query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>
	end?(): Promise<void>
}

export interface MigrationResult {
	applied: string[]
	baselined: string[]
	skipped: string[]
}

export interface ApplyMigrationOptions {
	lockName?: string
	lockTimeoutSeconds?: number
	now?: () => number
}

export interface RunMigrationOptions extends ApplyMigrationOptions {
	migrationsDirectory?: string
	connectionFactory?: () => Promise<MigrationConnection>
}

export class MigrationIntegrityError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'MigrationIntegrityError'
	}
}

export function calculateChecksum(content: string | Buffer): string {
	return createHash('sha256').update(content).digest('hex')
}

export function selectVersionedMigrationFiles(fileNames: readonly string[]): VersionedMigrationFile[] {
	const migrations = fileNames.flatMap((filename) => {
		const match = VERSIONED_MIGRATION_PATTERN.exec(filename)
		if (!match) {
			if (filename.startsWith('V') && filename.endsWith('.sql')) {
				throw new MigrationIntegrityError(`invalid versioned migration filename: ${filename}`)
			}
			return []
		}

		const version = Number(match[1])
		if (!Number.isSafeInteger(version)) {
			throw new MigrationIntegrityError(`migration version is outside the supported range: ${filename}`)
		}
		if (Array.from(filename).length > 255 || Array.from(match[2]).length > 255) {
			throw new MigrationIntegrityError(`migration filename or description is too long: ${filename}`)
		}

		return [{ version, description: match[2], filename }]
	})

	migrations.sort((left, right) => left.version - right.version || left.filename.localeCompare(right.filename))
	for (let index = 1; index < migrations.length; index += 1) {
		if (migrations[index - 1].version === migrations[index].version) {
			throw new MigrationIntegrityError(
				`duplicate migration version V${migrations[index].version}: ${migrations[index - 1].filename}, ${migrations[index].filename}`
			)
		}
	}

	return migrations
}

export async function discoverMigrations(directory: string): Promise<Migration[]> {
	const entries = await readdir(directory, { withFileTypes: true })
	const selected = selectVersionedMigrationFiles(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))

	return Promise.all(
		selected.map(async (migration) => {
			const content = await readFile(path.join(directory, migration.filename))
			const sql = content.toString('utf8')
			if (!sql.trim()) {
				throw new MigrationIntegrityError(`migration is empty: ${migration.filename}`)
			}
			return { ...migration, sql, checksum: calculateChecksum(content) }
		})
	)
}

export function validateAppliedMigrations(
	migrations: readonly Migration[],
	appliedMigrations: readonly AppliedMigration[]
): Set<number> {
	const availableByVersion = new Map(migrations.map((migration) => [migration.version, migration]))
	const appliedVersions = new Set<number>()

	for (const applied of appliedMigrations) {
		if (appliedVersions.has(applied.version)) {
			throw new MigrationIntegrityError(`duplicate schema history entry for V${applied.version}`)
		}
		appliedVersions.add(applied.version)

		const migration = availableByVersion.get(applied.version)
		if (!migration) {
			throw new MigrationIntegrityError(`applied migration V${applied.version} is missing from disk`)
		}
		if (migration.filename !== applied.filename) {
			throw new MigrationIntegrityError(
				`migration V${applied.version} filename changed: expected ${applied.filename}, found ${migration.filename}`
			)
		}
		if (migration.checksum.toLowerCase() !== applied.checksum.toLowerCase()) {
			throw new MigrationIntegrityError(`migration V${applied.version} checksum mismatch: ${migration.filename}`)
		}
	}

	if (appliedVersions.size > 0) {
		const highestAppliedVersion = Math.max(...appliedVersions)
		const outOfOrder = migrations.find(
			(migration) => migration.version < highestAppliedVersion && !appliedVersions.has(migration.version)
		)
		if (outOfOrder) {
			throw new MigrationIntegrityError(
				`cannot apply ${outOfOrder.filename} out of order after V${highestAppliedVersion}`
			)
		}
	}

	return appliedVersions
}

function rowsFromResult(result: [unknown, unknown]): Array<Record<string, unknown>> {
	const rows = result[0]
	return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
}

function numericValue(value: unknown): number {
	return typeof value === 'number' ? value : Number(value)
}

async function readAppliedMigrations(connection: MigrationConnection): Promise<AppliedMigration[]> {
	const rows = rowsFromResult(
		await connection.query(
			`SELECT version, script AS filename, checksum FROM \`${MIGRATION_HISTORY_TABLE}\` ORDER BY version ASC`
		)
	)

	return rows.map((row) => {
		const version = numericValue(row.version)
		if (!Number.isSafeInteger(version) || typeof row.filename !== 'string' || typeof row.checksum !== 'string') {
			throw new MigrationIntegrityError('schema history contains an invalid record')
		}
		return { version, filename: row.filename, checksum: row.checksum }
	})
}

export type QueueUniqueIndexState = 'absent' | 'compatible' | 'conflicting'

export async function inspectQueueUniqueIndex(connection: MigrationConnection): Promise<QueueUniqueIndexState> {
	const rows = rowsFromResult(
		await connection.query(
			`SELECT COLUMN_NAME AS column_name, SEQ_IN_INDEX AS seq_in_index,
			        NON_UNIQUE AS non_unique, SUB_PART AS sub_part
			 FROM information_schema.statistics
			 WHERE TABLE_SCHEMA = DATABASE()
			   AND TABLE_NAME = 'queue'
			   AND INDEX_NAME = 'uniq_queue_namespace_url'
			 ORDER BY SEQ_IN_INDEX ASC`
		)
	)
	if (rows.length === 0) return 'absent'

	const columns = rows.map((row) => String(row.column_name))
	const isUnique = rows.every((row) => numericValue(row.non_unique) === 0)
	const hasNoPrefix = rows.every((row) => row.sub_part === null || row.sub_part === undefined)
	const hasExpectedOrder =
		rows.length === 2 &&
		rows.every((row, index) => numericValue(row.seq_in_index) === index + 1) &&
		columns[0] === 'namespace' &&
		columns[1] === 'url'

	return isUnique && hasNoPrefix && hasExpectedOrder ? 'compatible' : 'conflicting'
}

interface ExpectedColumn {
	type: RegExp
	collation?: string
}

const V3_EXPECTED_COLUMNS = new Map<string, ExpectedColumn>([
	['namespace', { type: /^varchar\(64\)$/, collation: 'utf8mb4_bin' }],
	['url', { type: /^varchar\(255\)$/, collation: 'utf8mb4_bin' }],
	['count', { type: /^int(?:\(\d+\))? unsigned$/ }],
	['run_crontab', { type: /^varchar\(64\)$/, collation: 'utf8mb4_bin' }],
	['check_crontab', { type: /^varchar\(64\)$/, collation: 'utf8mb4_bin' }],
	['expire_crontab', { type: /^varchar\(64\)$/, collation: 'utf8mb4_bin' }],
])

export async function inspectV3Baseline(connection: MigrationConnection): Promise<QueueUniqueIndexState> {
	const indexState = await inspectQueueUniqueIndex(connection)
	if (indexState !== 'compatible') return indexState

	const tableRows = rowsFromResult(
		await connection.query(
			`SELECT TABLE_COLLATION AS table_collation
			 FROM information_schema.tables
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'queue'`
		)
	)
	if (tableRows.length !== 1 || tableRows[0].table_collation !== 'utf8mb4_bin') return 'conflicting'

	const columnRows = rowsFromResult(
		await connection.query(
			`SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type,
			        IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
			        COLLATION_NAME AS collation_name
			 FROM information_schema.columns
			 WHERE TABLE_SCHEMA = DATABASE()
			   AND TABLE_NAME = 'queue'
			   AND COLUMN_NAME IN ('namespace', 'url', 'count', 'run_crontab', 'check_crontab', 'expire_crontab')`
		)
	)
	if (columnRows.length !== V3_EXPECTED_COLUMNS.size) return 'conflicting'

	const schemaMatches = columnRows.every((row) => {
		const columnName = String(row.column_name)
		const expected = V3_EXPECTED_COLUMNS.get(columnName)
		if (!expected) return false
		const hasExpectedCollation = expected.collation === undefined || row.collation_name === expected.collation
		return (
			expected.type.test(String(row.column_type).toLowerCase()) &&
			row.is_nullable === 'NO' &&
			(row.column_default === null || row.column_default === undefined) &&
			hasExpectedCollation
		)
	})

	return schemaMatches ? 'compatible' : 'conflicting'
}

async function recordMigration(
	connection: MigrationConnection,
	migration: Migration,
	executionTimeMs: number,
	baselined: boolean
): Promise<void> {
	await connection.query(
		`INSERT INTO \`${MIGRATION_HISTORY_TABLE}\`
		 (version, description, script, checksum, execution_time_ms, baselined)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			migration.version,
			migration.description,
			migration.filename,
			migration.checksum,
			executionTimeMs,
			baselined ? 1 : 0,
		]
	)
}

function validateLockOptions(lockName: string, lockTimeoutSeconds: number): void {
	if (!lockName || Buffer.byteLength(lockName, 'utf8') > 64) {
		throw new Error('migration lock name must be between 1 and 64 bytes')
	}
	if (!Number.isInteger(lockTimeoutSeconds) || lockTimeoutSeconds < 0) {
		throw new Error('migration lock timeout must be a non-negative integer')
	}
}

export async function applyMigrations(
	connection: MigrationConnection,
	migrations: readonly Migration[],
	options: ApplyMigrationOptions = {}
): Promise<MigrationResult> {
	const lockName = options.lockName ?? MIGRATION_LOCK_NAME
	const lockTimeoutSeconds = options.lockTimeoutSeconds ?? 30
	const now = options.now ?? Date.now
	validateLockOptions(lockName, lockTimeoutSeconds)

	let lockAcquired = false
	let operationFailure: unknown
	try {
		const lockRows = rowsFromResult(
			await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, lockTimeoutSeconds])
		)
		lockAcquired = numericValue(lockRows[0]?.acquired) === 1
		if (!lockAcquired) throw new Error('could not acquire the database migration lock')

		await connection.query(
			`CREATE TABLE IF NOT EXISTS \`${MIGRATION_HISTORY_TABLE}\` (
				\`version\` BIGINT UNSIGNED NOT NULL,
				\`description\` VARCHAR(255) NOT NULL,
				\`script\` VARCHAR(255) NOT NULL,
				\`checksum\` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
				\`execution_time_ms\` INT UNSIGNED NOT NULL,
				\`baselined\` TINYINT(1) NOT NULL DEFAULT 0,
				\`installed_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
				PRIMARY KEY (\`version\`)
			) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = 'WaitQueue schema migration history'`
		)

		const appliedVersions = validateAppliedMigrations(migrations, await readAppliedMigrations(connection))
		const result: MigrationResult = { applied: [], baselined: [], skipped: [] }

		for (const migration of migrations) {
			if (appliedVersions.has(migration.version)) {
				result.skipped.push(migration.filename)
				continue
			}

			const startedAt = now()
			if (migration.version === 3 && migration.filename === V3_NORMALIZE_SCRIPT) {
				const baselineState = await inspectV3Baseline(connection)
				if (baselineState === 'conflicting') {
					throw new MigrationIntegrityError(
						'queue V3 marker exists but the normalized schema does not match V3__normalize_queue_schema.sql'
					)
				}
				if (baselineState === 'compatible') {
					await recordMigration(connection, migration, Math.max(0, now() - startedAt), true)
					result.baselined.push(migration.filename)
					continue
				}
			}

			await connection.query(migration.sql)
			await recordMigration(connection, migration, Math.max(0, now() - startedAt), false)
			result.applied.push(migration.filename)
		}

		return result
	} catch (error) {
		operationFailure = error
		throw error
	} finally {
		if (lockAcquired) {
			try {
				const releaseRows = rowsFromResult(await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]))
				if (numericValue(releaseRows[0]?.released) !== 1) {
					throw new Error('database migration lock was not released')
				}
			} catch (releaseError) {
				if (!operationFailure) throw releaseError
				logger.error({ err: releaseError }, 'failed to release database migration lock after migration failure')
			}
		}
	}
}

async function createDefaultConnection(): Promise<MigrationConnection> {
	const connection = await createConnection({
		host: env.database.host,
		port: env.database.port,
		user: env.database.username,
		password: env.database.password,
		database: env.database.database,
		charset: 'utf8mb4',
		multipleStatements: true,
	})

	return {
		query: async (sql, values = []) => connection.query(sql, values),
		end: () => connection.end(),
	}
}

export async function runMigrations(options: RunMigrationOptions = {}): Promise<MigrationResult> {
	const migrationsDirectory = options.migrationsDirectory ?? path.resolve(__dirname, '../sql')
	const migrations = await discoverMigrations(migrationsDirectory)
	const connection = await (options.connectionFactory ?? createDefaultConnection)()

	let migrationFailure: unknown
	try {
		return await applyMigrations(connection, migrations, options)
	} catch (error) {
		migrationFailure = error
		throw error
	} finally {
		try {
			await connection.end?.()
		} catch (closeError) {
			if (!migrationFailure) throw closeError
			logger.error({ err: closeError }, 'failed to close migration database connection after migration failure')
		}
	}
}

if (require.main === module) {
	void runMigrations()
		.then((result) => {
			logger.info(
				{
					applied: result.applied.length,
					baselined: result.baselined.length,
					skipped: result.skipped.length,
				},
				'database migrations completed'
			)
		})
		.catch((error) => {
			logger.fatal({ err: error }, 'database migration failed')
			process.exitCode = 1
		})
}
