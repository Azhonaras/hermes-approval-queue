-- SQL Server schema for the approval queue. Idempotent.
IF OBJECT_ID(N'dbo.Approvals', N'U') IS NULL
CREATE TABLE dbo.Approvals (
    ApprovalId           BIGINT IDENTITY(1,1) PRIMARY KEY,
    SiteId               INT            NOT NULL,
    ResourceType         NVARCHAR(100)  NOT NULL,
    ResourceIdJson       NVARCHAR(200)  NOT NULL,   -- JSON value, so 42 and "42" stay different
    Action               NVARCHAR(100)  NOT NULL,
    Scope                NVARCHAR(100)  NOT NULL,
    Status               NVARCHAR(20)   NOT NULL,
    Reason               NVARCHAR(MAX)  NOT NULL,
    ProposalJson         NVARCHAR(MAX)  NOT NULL,
    OriginalProposalJson NVARCHAR(MAX)  NULL,
    EditedProposal       BIT            NOT NULL DEFAULT 0,
    DecisionReason       NVARCHAR(MAX)  NULL,
    RevisionOfApprovalId BIGINT         NULL,
    CreatedUtc           DATETIME2(3)   NOT NULL,
    DecidedUtc           DATETIME2(3)   NULL,
    DecidedBy            NVARCHAR(200)  NULL,
    ExpiresUtc           DATETIME2(3)   NOT NULL,
    ConsumedUtc          DATETIME2(3)   NULL,
    CONSTRAINT CK_Approvals_Status CHECK (Status IN (N'Pending',N'Approved',N'Rejected',N'ChangesRequested',N'Consumed',N'Expired'))
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Approvals_Status')
    CREATE INDEX IX_Approvals_Status ON dbo.Approvals (Status, CreatedUtc DESC);

IF OBJECT_ID(N'dbo.CmsResources', N'U') IS NULL
CREATE TABLE dbo.CmsResources (   -- demo content; replace with your own tables
    SiteId         INT           NOT NULL,
    ResourceType   NVARCHAR(100) NOT NULL,
    ResourceIdJson NVARCHAR(200) NOT NULL,
    FieldsJson     NVARCHAR(MAX) NOT NULL,
    PRIMARY KEY (SiteId, ResourceType, ResourceIdJson)
);

IF OBJECT_ID(N'dbo.AuditLog', N'U') IS NULL
CREATE TABLE dbo.AuditLog (       -- one row per executed write, written in the same transaction
    AuditId      BIGINT IDENTITY(1,1) PRIMARY KEY,
    ApprovalId   BIGINT        NOT NULL,
    Action       NVARCHAR(100) NOT NULL,
    ResourceType NVARCHAR(100) NOT NULL,
    ResourceIdJson NVARCHAR(200) NOT NULL,
    ProposalJson NVARCHAR(MAX) NOT NULL,
    AtUtc        DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME()
);
