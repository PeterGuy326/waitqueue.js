import { Sequelize } from 'sequelize'

interface DaoMysqlConf {
	database: string
	username: string
	password: string
	host: string
	port: number
}

class DaoMysql {
	private sequelize: Sequelize
	constructor(params: DaoMysqlConf) {
		const { database, username, password, host, port } = params
        this.sequelize = new Sequelize(database, username, password, {
			host,
			port,
			dialect: 'mysql',
		})
	}
	getInstance() {
		return this.sequelize
	}
}

export const daoMysql = new DaoMysql({
    database: process.env.DB_DATABASE || 'test',
    username: process.env.DB_USER || 'remote',
    password: process.env.DB_PASSWORD || '123456',
    host: process.env.DB_HOST || '127.0.0.1',
    port: +(process.env.DB_PORT || 3306)
})
