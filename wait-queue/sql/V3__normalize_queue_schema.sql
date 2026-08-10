ALTER TABLE `queue`
	CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
	MODIFY `namespace` VARCHAR(64) NOT NULL COMMENT '命名空间',
	MODIFY `url` VARCHAR(255) NOT NULL COMMENT '回调事件接口',
	MODIFY `count` INT UNSIGNED NOT NULL COMMENT '队列支持的并发数量',
	MODIFY `run_crontab` VARCHAR(64) NOT NULL COMMENT '运行周期规则',
	MODIFY `check_crontab` VARCHAR(64) NOT NULL COMMENT '检查周期规则',
	MODIFY `expire_crontab` VARCHAR(64) NOT NULL COMMENT '过期周期规则',
	ADD UNIQUE KEY `uniq_queue_namespace_url` (`namespace`, `url`);
