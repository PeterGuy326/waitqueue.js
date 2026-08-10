import { DataTypes, Model, ModelAttributes, ModelOptions } from 'sequelize'
import { daoMysql } from '../conf/db'

const attributes: ModelAttributes = {
	id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, comment: '队列 id' },
	namespace: { type: DataTypes.STRING(64), allowNull: false, comment: '服务命名空间' },
	count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, comment: '执行任务并发数量' },
	url: { type: DataTypes.STRING(255), allowNull: false, comment: '回调事件接口' },
	runCrontab: { field: 'run_crontab', type: DataTypes.STRING(64), allowNull: false, comment: '运行周期规则' },
	checkCrontab: { field: 'check_crontab', type: DataTypes.STRING(64), allowNull: false, comment: '检查周期规则' },
	expireCrontab: { field: 'expire_crontab', type: DataTypes.STRING(64), allowNull: false, comment: '过期周期规则' },
	createdTime: { field: 'created_time', type: DataTypes.DATE, comment: '创建时间' },
	updatedTime: { field: 'updated_time', type: DataTypes.DATE, comment: '更新时间' },
}

const defineOptions: ModelOptions = {
	timestamps: true,
	updatedAt: 'updatedTime',
	createdAt: 'createdTime',
	freezeTableName: true,
	indexes: [{ unique: true, fields: ['namespace', 'url'], name: 'uniq_queue_namespace_url' }],
}

interface QueueAttributes extends Model {
	id: number
	namespace: string
	count: number
	url: string
	runCrontab: string
	checkCrontab: string
	expireCrontab: string
	createdTime: Date
	updatedTime: Date
}

const QueueDao = daoMysql.getInstance().define<QueueAttributes>('queue', attributes, defineOptions)

export { QueueAttributes, QueueDao }
