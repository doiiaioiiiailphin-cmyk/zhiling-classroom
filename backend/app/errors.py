class AppError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def payload(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


def missing(resource: str) -> AppError:
    return AppError(404, "NOT_FOUND", f"{resource}不存在")
