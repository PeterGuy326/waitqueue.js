const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

const {
	MigrationIntegrityError,
	V3_NORMALIZE_SCRIPT,
	applyMigrations,
	calculateChecksum,
	discoverMigrations,
	runMigrations,
	selectVersionedMigrationFiles,
	validateAppliedMigrations,
} = require('../dist/migrate.js')

function migration(version, filename, checksum = String(version).repeat(64)) {
	return {
		version,
		filename,
		description: filename.slice(filename.indexOf('__') + 2, -4),
		sql: `-- execute ${filename}`,
		checksum,
	}
}

function fakeConnection(handler) {
	const calls = []
	return {
		calls,
		async query(sql, values = []) {
			calls.push({ sql, values })
			return handler(sql, values, calls)
		},
	}
}

function commonQueryResult(sql) {
	if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []]
	if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []]
	if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) return [{ affectedRows: 0 }, []]
	if (sql.startsWith('INSERT INTO')) return [{ affectedRows: 1 }, []]
	return undefined
}

test('versioned migration selection ignores undo files and sorts versions numerically', () => {
	const selected = selectVersionedMigrationFiles([
		'V10__later.sql',
		'U2__init_schema.sql',
		'notes.sql',
		'V3__normalize.sql',
		'v4__lowercase.sql',
		'V2__init.sql',
	])

	assert.deepEqual(
		selected.map(({ version, filename }) => ({ version, filename })),
		[
			{ version: 2, filename: 'V2__init.sql' },
			{ version: 3, filename: 'V3__normalize.sql' },
			{ version: 10, filename: 'V10__later.sql' },
		]
	)
})

test('versioned migration selection rejects duplicate numeric versions', () => {
	assert.throws(
		() => selectVersionedMigrationFiles(['V2__first.sql', 'V2__second.sql']),
		(error) => error instanceof MigrationIntegrityError && /duplicate migration version V2/.test(error.message)
	)
	assert.throws(() => selectVersionedMigrationFiles(['V03__leading_zero.sql']), /invalid versioned migration filename/)
	assert.throws(() => selectVersionedMigrationFiles(['V4_missing_separator.sql']), /invalid versioned migration filename/)
})

test('migration discovery loads only V scripts and hashes their exact bytes', async () => {
	const sqlDirectory = path.resolve(__dirname, '../sql')
	const migrations = await discoverMigrations(sqlDirectory)

	assert.deepEqual(
		migrations.map(({ version, filename }) => ({ version, filename })),
		[
			{ version: 2, filename: 'V2__init_schema.sql' },
			{ version: 3, filename: 'V3__normalize_queue_schema.sql' },
		]
	)
	for (const migration of migrations) {
		const bytes = await readFile(path.join(sqlDirectory, migration.filename))
		assert.equal(migration.checksum, calculateChecksum(bytes))
		assert.match(migration.checksum, /^[a-f0-9]{64}$/)
	}
})

test('SHA-256 checksum is stable and detects changed migration content', () => {
	assert.equal(calculateChecksum('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
	assert.notEqual(calculateChecksum('SELECT 1;'), calculateChecksum('SELECT 2;'))
})

test('applied migrations are skipped only when filename and checksum still match', () => {
	const migrations = [migration(2, 'V2__init.sql', 'a'.repeat(64)), migration(3, 'V3__next.sql', 'b'.repeat(64))]
	assert.deepEqual(
		[...validateAppliedMigrations(migrations, [{ version: 2, filename: 'V2__init.sql', checksum: 'A'.repeat(64) }])],
		[2]
	)

	assert.throws(
		() =>
			validateAppliedMigrations(migrations, [
				{ version: 2, filename: 'V2__init.sql', checksum: 'c'.repeat(64) },
			]),
		/checksum mismatch/
	)
	assert.throws(
		() =>
			validateAppliedMigrations(migrations, [
				{ version: 4, filename: 'V4__missing.sql', checksum: 'd'.repeat(64) },
			]),
		/missing from disk/
	)
	assert.throws(
		() =>
			validateAppliedMigrations(migrations, [
				{ version: 3, filename: 'V3__next.sql', checksum: 'b'.repeat(64) },
			]),
		/out of order/
	)
})

test('migration runner serializes with GET_LOCK and baselines a compatible existing V3 index', async () => {
	const migrations = [
		migration(2, 'V2__init_schema.sql', 'a'.repeat(64)),
		migration(3, V3_NORMALIZE_SCRIPT, 'b'.repeat(64)),
	]
	const executedScripts = []
	const recorded = []
	const connection = fakeConnection(async (sql, values) => {
		const common = commonQueryResult(sql)
		if (common) {
			if (sql.startsWith('INSERT INTO')) recorded.push(values)
			return common
		}
		if (sql.startsWith('SELECT version')) return [[], []]
		if (sql.includes('information_schema.statistics')) {
			return [
				[
					{ column_name: 'namespace', seq_in_index: 1, non_unique: 0, sub_part: null },
					{ column_name: 'url', seq_in_index: 2, non_unique: 0, sub_part: null },
				],
				[],
			]
		}
		if (sql.includes('information_schema.tables')) return [[{ table_collation: 'utf8mb4_bin' }], []]
		if (sql.includes('information_schema.columns')) {
			return [
				[
					{
						column_name: 'namespace',
						column_type: 'varchar(64)',
						is_nullable: 'NO',
						column_default: null,
						collation_name: 'utf8mb4_bin',
					},
					{
						column_name: 'url',
						column_type: 'varchar(255)',
						is_nullable: 'NO',
						column_default: null,
						collation_name: 'utf8mb4_bin',
					},
					{
						column_name: 'count',
						column_type: 'int unsigned',
						is_nullable: 'NO',
						column_default: null,
						collation_name: null,
					},
					...['run_crontab', 'check_crontab', 'expire_crontab'].map((column_name) => ({
						column_name,
						column_type: 'varchar(64)',
						is_nullable: 'NO',
						column_default: null,
						collation_name: 'utf8mb4_bin',
					})),
				],
				[],
			]
		}
		executedScripts.push(sql)
		return [{ affectedRows: 0 }, []]
	})

	let clock = 100
	const result = await applyMigrations(connection, migrations, { now: () => clock++ })

	assert.deepEqual(result, {
		applied: ['V2__init_schema.sql'],
		baselined: [V3_NORMALIZE_SCRIPT],
		skipped: [],
	})
	assert.deepEqual(executedScripts, ['-- execute V2__init_schema.sql'])
	assert.equal(recorded.length, 2)
	assert.equal(recorded[0].at(-1), 0)
	assert.equal(recorded[1].at(-1), 1)
	assert.match(connection.calls[0].sql, /GET_LOCK/)
	assert.match(connection.calls.at(-1).sql, /RELEASE_LOCK/)
})

test('migration runner skips a valid history record and rejects checksum drift before execution', async () => {
	const existing = migration(2, 'V2__init_schema.sql', 'a'.repeat(64))
	const createConnection = (checksum) =>
		fakeConnection(async (sql) => {
			const common = commonQueryResult(sql)
			if (common) return common
			if (sql.startsWith('SELECT version')) {
				return [[{ version: '2', filename: existing.filename, checksum }], []]
			}
			throw new Error(`unexpected migration execution: ${sql}`)
		})

	const matching = createConnection(existing.checksum)
	assert.deepEqual(await applyMigrations(matching, [existing]), {
		applied: [],
		baselined: [],
		skipped: [existing.filename],
	})

	const changed = createConnection('f'.repeat(64))
	await assert.rejects(() => applyMigrations(changed, [existing]), /checksum mismatch/)
	assert.match(changed.calls.at(-1).sql, /RELEASE_LOCK/)
})

test('migration runner refuses a conflicting V3 index and always releases its lock', async () => {
	const v3 = migration(3, V3_NORMALIZE_SCRIPT, 'b'.repeat(64))
	const connection = fakeConnection(async (sql) => {
		const common = commonQueryResult(sql)
		if (common) return common
		if (sql.startsWith('SELECT version')) return [[], []]
		if (sql.includes('information_schema.statistics')) {
			return [[{ column_name: 'url', seq_in_index: 1, non_unique: 1 }], []]
		}
		throw new Error(`unexpected query: ${sql}`)
	})

	await assert.rejects(() => applyMigrations(connection, [v3]), /normalized schema does not match/)
	assert.match(connection.calls.at(-1).sql, /RELEASE_LOCK/)
})

test('migration runner does not baseline V3 when only the marker index was added to an old schema', async () => {
	const v3 = migration(3, V3_NORMALIZE_SCRIPT, 'b'.repeat(64))
	const connection = fakeConnection(async (sql) => {
		const common = commonQueryResult(sql)
		if (common) return common
		if (sql.startsWith('SELECT version')) return [[], []]
		if (sql.includes('information_schema.statistics')) {
			return [
				[
					{ column_name: 'namespace', seq_in_index: 1, non_unique: 0, sub_part: null },
					{ column_name: 'url', seq_in_index: 2, non_unique: 0, sub_part: null },
				],
				[],
			]
		}
		if (sql.includes('information_schema.tables')) return [[{ table_collation: 'utf8mb4_general_ci' }], []]
		throw new Error(`unexpected query: ${sql}`)
	})

	await assert.rejects(() => applyMigrations(connection, [v3]), /normalized schema does not match/)
	assert.match(connection.calls.at(-1).sql, /RELEASE_LOCK/)
})

test('migration runner rejects a prefix-only V3 unique index', async () => {
	const v3 = migration(3, V3_NORMALIZE_SCRIPT, 'b'.repeat(64))
	const connection = fakeConnection(async (sql) => {
		const common = commonQueryResult(sql)
		if (common) return common
		if (sql.startsWith('SELECT version')) return [[], []]
		if (sql.includes('information_schema.statistics')) {
			return [
				[
					{ column_name: 'namespace', seq_in_index: 1, non_unique: 0, sub_part: 8 },
					{ column_name: 'url', seq_in_index: 2, non_unique: 0, sub_part: 32 },
				],
				[],
			]
		}
		throw new Error(`unexpected query: ${sql}`)
	})

	await assert.rejects(() => applyMigrations(connection, [v3]), /normalized schema does not match/)
	assert.match(connection.calls.at(-1).sql, /RELEASE_LOCK/)
})

test('migration runner releases its lock after migration SQL fails', async () => {
	const v2 = migration(2, 'V2__init_schema.sql', 'a'.repeat(64))
	const connection = fakeConnection(async (sql) => {
		const common = commonQueryResult(sql)
		if (common) return common
		if (sql.startsWith('SELECT version')) return [[], []]
		if (sql === v2.sql) throw new Error('synthetic DDL failure')
		throw new Error(`unexpected query: ${sql}`)
	})

	await assert.rejects(() => applyMigrations(connection, [v2]), /synthetic DDL failure/)
	assert.match(connection.calls.at(-1).sql, /RELEASE_LOCK/)
})

test('migration runner stops without touching schema when GET_LOCK times out', async () => {
	const connection = fakeConnection(async (sql) => {
		if (sql.includes('GET_LOCK')) return [[{ acquired: 0 }], []]
		throw new Error(`unexpected query: ${sql}`)
	})

	await assert.rejects(() => applyMigrations(connection, []), /could not acquire/)
	assert.equal(connection.calls.length, 1)
})

test('runMigrations closes its dedicated connection and preserves a primary migration error', async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'waitqueue-migrations-'))
	t.after(() => rm(directory, { recursive: true, force: true }))

	let successfulEnds = 0
	const successfulConnection = fakeConnection(async (sql) => {
		const common = commonQueryResult(sql)
		if (common) return common
		if (sql.startsWith('SELECT version')) return [[], []]
		throw new Error(`unexpected query: ${sql}`)
	})
	successfulConnection.end = async () => {
		successfulEnds += 1
	}
	assert.deepEqual(
		await runMigrations({ migrationsDirectory: directory, connectionFactory: async () => successfulConnection }),
		{ applied: [], baselined: [], skipped: [] }
	)
	assert.equal(successfulEnds, 1)

	let failedEnds = 0
	const failedConnection = fakeConnection(async (sql) => {
		if (sql.includes('GET_LOCK')) return [[{ acquired: 0 }], []]
		throw new Error(`unexpected query: ${sql}`)
	})
	failedConnection.end = async () => {
		failedEnds += 1
		throw new Error('synthetic close failure')
	}
	await assert.rejects(
		() => runMigrations({ migrationsDirectory: directory, connectionFactory: async () => failedConnection }),
		/could not acquire the database migration lock/
	)
	assert.equal(failedEnds, 1)
})
