import { Sequelize } from 'sequelize'

import { env } from './env'

class DaoMysql {
	private sequelize: Sequelize
	constructor() {
		const { database, username, password, host, port } = env.database
		this.sequelize = new Sequelize(database, username, password, {
			host,
			port,
			dialect: 'mysql',
			logging: false,
		})
	}

	getInstance() {
		return this.sequelize
	}
}

export const daoMysql = new DaoMysql()
