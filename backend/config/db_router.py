class ADCDatabaseRouter:
    runtime_labels = {"sessions", "django_cache"}

    def db_for_read(self, model, **hints):
        return self.database_for(model)

    def db_for_write(self, model, **hints):
        return self.database_for(model)

    def database_for(self, model):
        return "runtime" if model._meta.app_label in self.runtime_labels else "default"

    def allow_relation(self, obj1, obj2, **hints):
        return self.database_for(type(obj1)) == self.database_for(type(obj2))

    def allow_migrate(self, db, app_label, **hints):
        return db == "runtime" and app_label in self.runtime_labels
