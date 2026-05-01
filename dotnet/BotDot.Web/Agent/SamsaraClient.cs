// Cliente Samsara — interface + mock + real (Fase 7).
//
// Ahora (Fase 4) solo usamos el mock para que el chat E2E funcione. La
// implementacion real con HttpClient queda para la fase de jobs/sync.

namespace BotDot.Web.Agent;

public class SamsaraDriver
{
    public string SamsaraId { get; set; } = "";
    public string Name { get; set; } = "";
    public string CdlNumber { get; set; } = "";
    public string CdlState { get; set; } = "";
    public string CdlExpiration { get; set; } = "";
    public string MedicalCardExpiration { get; set; } = "";
    public string Endorsements { get; set; } = "";
}

public class SamsaraVehicle
{
    public string SamsaraId { get; set; } = "";
    public string Vin { get; set; } = "";
    public string Unit { get; set; } = "";
    public string Make { get; set; } = "";
    public string Model { get; set; } = "";
    public int Year { get; set; }
    public string AnnualInspection { get; set; } = "";
    public bool Oos { get; set; }
}

public class SamsaraHosClock
{
    public string DriverId { get; set; } = "";
    public string DriverName { get; set; } = "";
    public string ClockState { get; set; } = "";   // driving / on_duty_not_driving / off_duty / sleeper_berth
    public int DrivingTimeSec { get; set; }
    public int OnDutyTimeSec { get; set; }
    public int CycleTimeSec { get; set; }
}

public interface ISamsaraClient
{
    Task<IReadOnlyList<SamsaraDriver>> ListDriversAsync(CancellationToken ct = default);
    Task<IReadOnlyList<SamsaraVehicle>> ListVehiclesAsync(CancellationToken ct = default);
    Task<IReadOnlyList<SamsaraHosClock>> GetHosClocksAsync(CancellationToken ct = default);
    Task<SamsaraHosClock?> GetDriverHosAsync(string driverIdOrName, CancellationToken ct = default);
}

/// <summary>
/// Mock con fixtures realistas — matchea src/integrations/samsara-mock.js del Node.
/// Activacion: BotDot:Samsara:Mock=true.
/// </summary>
public class SamsaraMockClient : ISamsaraClient
{
    private static readonly SamsaraDriver[] Drivers = new[]
    {
        new SamsaraDriver { SamsaraId = "sams_d_001", Name = "Maria Gonzalez",     CdlNumber = "TX12345678", CdlState = "TX", CdlExpiration = "2027-08-15", MedicalCardExpiration = "2026-09-30", Endorsements = "H,N" },
        new SamsaraDriver { SamsaraId = "sams_d_002", Name = "Juan Hernandez",     CdlNumber = "TX23456789", CdlState = "TX", CdlExpiration = "2026-12-01", MedicalCardExpiration = "2026-06-15", Endorsements = "H" },
        new SamsaraDriver { SamsaraId = "sams_d_003", Name = "Roberto Sanchez",    CdlNumber = "TX34567890", CdlState = "TX", CdlExpiration = "2028-03-20", MedicalCardExpiration = "2027-01-10", Endorsements = "T" },
        new SamsaraDriver { SamsaraId = "sams_d_004", Name = "Sthepanie Michelle", CdlNumber = "TX45678901", CdlState = "TX", CdlExpiration = "2027-05-12", MedicalCardExpiration = "2026-11-22", Endorsements = "" },
        new SamsaraDriver { SamsaraId = "sams_d_005", Name = "Carlos Ramirez",     CdlNumber = "TX56789012", CdlState = "TX", CdlExpiration = "2026-05-08", MedicalCardExpiration = "2026-05-30", Endorsements = "H,T,N" },
        new SamsaraDriver { SamsaraId = "sams_d_006", Name = "Ana Lopez",          CdlNumber = "TX67890123", CdlState = "TX", CdlExpiration = "2027-11-30", MedicalCardExpiration = "2026-08-04", Endorsements = "" },
        new SamsaraDriver { SamsaraId = "sams_d_007", Name = "Luis Martinez",      CdlNumber = "TX78901234", CdlState = "TX", CdlExpiration = "2028-01-15", MedicalCardExpiration = "2027-02-18", Endorsements = "H" },
        new SamsaraDriver { SamsaraId = "sams_d_008", Name = "Sofia Rodriguez",    CdlNumber = "TX89012345", CdlState = "TX", CdlExpiration = "2026-07-25", MedicalCardExpiration = "2026-04-30", Endorsements = "" },
        new SamsaraDriver { SamsaraId = "sams_d_009", Name = "Pedro Garcia",       CdlNumber = "TX90123456", CdlState = "TX", CdlExpiration = "2027-09-09", MedicalCardExpiration = "2026-12-12", Endorsements = "T" },
        new SamsaraDriver { SamsaraId = "sams_d_010", Name = "Diana Torres",       CdlNumber = "TX01234567", CdlState = "TX", CdlExpiration = "2028-06-30", MedicalCardExpiration = "2027-04-04", Endorsements = "" },
    };

    private static readonly SamsaraVehicle[] Vehicles = new[]
    {
        new SamsaraVehicle { SamsaraId = "sams_v_001", Vin = "1FUJGLDR0CSBM0001", Unit = "101", Make = "Freightliner",  Model = "Cascadia", Year = 2022, AnnualInspection = "2026-02-15", Oos = false },
        new SamsaraVehicle { SamsaraId = "sams_v_002", Vin = "1FUJGLDR0CSBM0002", Unit = "102", Make = "Freightliner",  Model = "Cascadia", Year = 2023, AnnualInspection = "2025-11-10", Oos = false },
        new SamsaraVehicle { SamsaraId = "sams_v_003", Vin = "3HSDJSJR0CN500003", Unit = "103", Make = "International", Model = "LT",       Year = 2021, AnnualInspection = "2026-01-22", Oos = true  },
        new SamsaraVehicle { SamsaraId = "sams_v_004", Vin = "1XKYDP9X0NJ500004", Unit = "104", Make = "Kenworth",      Model = "T680",     Year = 2024, AnnualInspection = "2026-03-05", Oos = false },
        new SamsaraVehicle { SamsaraId = "sams_v_005", Vin = "1FUJA6CK0NH500005", Unit = "105", Make = "Volvo",         Model = "VNL",      Year = 2022, AnnualInspection = "2025-12-01", Oos = false },
    };

    private static readonly SamsaraHosClock[] Clocks = new[]
    {
        new SamsaraHosClock { DriverId = "sams_d_001", DriverName = "Maria Gonzalez",     ClockState = "on_duty_not_driving", DrivingTimeSec =  3 * 3600, OnDutyTimeSec =  4 * 3600, CycleTimeSec = 30 * 3600 },
        new SamsaraHosClock { DriverId = "sams_d_002", DriverName = "Juan Hernandez",     ClockState = "driving",             DrivingTimeSec = 10 * 3600, OnDutyTimeSec = 12 * 3600, CycleTimeSec = 50 * 3600 },
        new SamsaraHosClock { DriverId = "sams_d_003", DriverName = "Roberto Sanchez",    ClockState = "off_duty",            DrivingTimeSec =  0,        OnDutyTimeSec =  0,        CycleTimeSec = 25 * 3600 },
        new SamsaraHosClock { DriverId = "sams_d_004", DriverName = "Sthepanie Michelle", ClockState = "on_duty_not_driving", DrivingTimeSec =  1 * 3600, OnDutyTimeSec =  2 * 3600, CycleTimeSec = 20 * 3600 },
        new SamsaraHosClock { DriverId = "sams_d_005", DriverName = "Carlos Ramirez",     ClockState = "driving",             DrivingTimeSec =  8 * 3600, OnDutyTimeSec = 10 * 3600, CycleTimeSec = 45 * 3600 },
        new SamsaraHosClock { DriverId = "sams_d_006", DriverName = "Ana Lopez",          ClockState = "on_duty_not_driving", DrivingTimeSec =  5 * 3600, OnDutyTimeSec =  7 * 3600, CycleTimeSec = 62 * 3600 },
        new SamsaraHosClock { DriverId = "sams_d_007", DriverName = "Luis Martinez",      ClockState = "sleeper_berth",       DrivingTimeSec =  0,        OnDutyTimeSec =  0,        CycleTimeSec = 35 * 3600 },
        new SamsaraHosClock { DriverId = "sams_d_008", DriverName = "Sofia Rodriguez",    ClockState = "off_duty",            DrivingTimeSec =  0,        OnDutyTimeSec =  0,        CycleTimeSec = 18 * 3600 },
        new SamsaraHosClock { DriverId = "sams_d_009", DriverName = "Pedro Garcia",       ClockState = "driving",             DrivingTimeSec =  9 * 3600, OnDutyTimeSec = 11 * 3600, CycleTimeSec = 55 * 3600 },
        new SamsaraHosClock { DriverId = "sams_d_010", DriverName = "Diana Torres",       ClockState = "on_duty_not_driving", DrivingTimeSec =  2 * 3600, OnDutyTimeSec =  3 * 3600, CycleTimeSec = 22 * 3600 },
    };

    public Task<IReadOnlyList<SamsaraDriver>> ListDriversAsync(CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<SamsaraDriver>>(Drivers);

    public Task<IReadOnlyList<SamsaraVehicle>> ListVehiclesAsync(CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<SamsaraVehicle>>(Vehicles);

    public Task<IReadOnlyList<SamsaraHosClock>> GetHosClocksAsync(CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<SamsaraHosClock>>(Clocks);

    public Task<SamsaraHosClock?> GetDriverHosAsync(string driverIdOrName, CancellationToken ct = default)
    {
        var q = (driverIdOrName ?? "").Trim().ToLowerInvariant();
        var found = Clocks.FirstOrDefault(c =>
            c.DriverId.Equals(driverIdOrName, StringComparison.OrdinalIgnoreCase) ||
            c.DriverName.ToLowerInvariant().Contains(q));
        return Task.FromResult<SamsaraHosClock?>(found);
    }
}

/// <summary>
/// Cliente real Samsara — STUB para Fase 4. Implementacion completa va en
/// Fase 7 (sync background jobs). Si alguien lo llama con BotDot:Samsara:Mock=false
/// va a tirar excepcion — no queremos un fail silencioso.
/// </summary>
public class SamsaraHttpClient : ISamsaraClient
{
    public Task<IReadOnlyList<SamsaraDriver>> ListDriversAsync(CancellationToken ct = default)
        => throw new NotImplementedException("SamsaraHttpClient pendiente Fase 7. Usar BotDot:Samsara:Mock=true mientras tanto.");
    public Task<IReadOnlyList<SamsaraVehicle>> ListVehiclesAsync(CancellationToken ct = default)
        => throw new NotImplementedException("SamsaraHttpClient pendiente Fase 7.");
    public Task<IReadOnlyList<SamsaraHosClock>> GetHosClocksAsync(CancellationToken ct = default)
        => throw new NotImplementedException("SamsaraHttpClient pendiente Fase 7.");
    public Task<SamsaraHosClock?> GetDriverHosAsync(string driverIdOrName, CancellationToken ct = default)
        => throw new NotImplementedException("SamsaraHttpClient pendiente Fase 7.");
}
